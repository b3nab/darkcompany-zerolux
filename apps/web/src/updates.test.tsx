import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import {
  UpdateButton,
  UpdateControl,
  UpdateDetails,
  UpdateSettings,
} from "./Updates";
import { updateStore } from "./update-state";
import type { UpdateState } from "./update-state";

const state = (phase: UpdateState["phase"] = "idle"): UpdateState => ({
  channel: "nightly",
  current: {
    version: "0.0.1-alpha.20261023.1",
    channel: "nightly",
    commit: "abc12345",
    built_at: "2026-10-23T12:00:00Z",
    dirty: false,
  },
  phase,
  ...(phase !== "idle"
    ? {
        available: {
          version: "0.0.1-alpha.20261023.2",
          commit: "def67890",
          built_at: "2026-10-23T13:00:00Z",
          notes: "",
        },
      }
    : {}),
});
const tick = () => new Promise<void>((resolve) => queueMicrotask(resolve));

test("header and settings share a listener; a late status cannot replace download progress", async () => {
  let receive!: (value: UpdateState) => void;
  const initial = Promise.withResolvers<UpdateState>();
  const calls: string[] = [];
  let listens = 0,
    stopped = 0;
  const store = updateStore({
    listen: async (listener) => {
      listens++;
      receive = listener;
      return () => stopped++;
    },
    invoke: async (command) => {
      calls.push(command);
      return initial.promise;
    },
  });
  const header = store.subscribe(() => {});
  const settings = store.subscribe(() => {});
  await tick();
  expect(listens).toBe(1);
  expect(calls).toEqual(["update_status"]);
  receive({ ...state("downloading"), downloaded: 42, total: 100 });
  initial.resolve(state("available"));
  await tick();
  await tick();
  expect(store.snapshot().state?.downloaded).toBe(42);
  header();
  expect(stopped).toBe(0);
  settings();
  expect(stopped).toBe(1);
});

test("leaving before native event registration completes closes it without querying", async () => {
  const registration = Promise.withResolvers<() => void>();
  let stopped = 0,
    queried = 0;
  const store = updateStore({
    listen: () => registration.promise,
    invoke: async () => {
      queried++;
      return state();
    },
  });
  store.subscribe(() => {})();
  registration.resolve(() => stopped++);
  await tick();
  expect(stopped).toBe(1);
  expect(queried).toBe(0);
});

test("a rejected restart preserves the verified ready update for another attempt", async () => {
  const calls: string[] = [];
  const store = updateStore({
    listen: async () => () => {},
    invoke: async (command) => {
      calls.push(command);
      if (command === "update_install")
        throw new Error("Messages are waiting to be sent");
      return state("ready");
    },
  });
  const stop = store.subscribe(() => {});
  await tick();
  await tick();
  await store.act("update_install");
  expect(store.snapshot().state?.phase).toBe("ready");
  expect(store.snapshot().error).toBe("Messages are waiting to be sent");
  expect(store.snapshot().pending).toBe(false);
  expect(calls).toEqual(["update_status", "update_install"]);
  stop();
});

test("one action at a time; an older reply cannot replace a newer native event", async () => {
  let receive!: (value: UpdateState) => void;
  const download = Promise.withResolvers<UpdateState>();
  const calls: string[] = [];
  const store = updateStore({
    listen: async (listener) => {
      receive = listener;
      return () => {};
    },
    invoke: async (command) => {
      calls.push(command);
      return command === "update_status"
        ? state("available")
        : download.promise;
    },
  });
  const stop = store.subscribe(() => {});
  await tick();
  await tick();
  const operation = store.act("update_download");
  await store.act("update_install");
  receive(state("ready"));
  download.resolve(state("downloading"));
  await operation;
  expect(store.snapshot().state?.phase).toBe("ready");
  expect(calls).toEqual(["update_status", "update_download"]);
  stop();
});

test("channel changes go to the native app and use its confirmed selection", async () => {
  const calls: unknown[] = [];
  const store = updateStore({
    listen: async () => () => {},
    invoke: async (command, args) => {
      calls.push([command, args]);
      return { ...state(), channel: args?.channel ?? "nightly" };
    },
  });
  await store.act("update_channel", "stable");
  expect(calls).toEqual([["update_channel", { channel: "stable" }]]);
  expect(store.snapshot().state?.channel).toBe("stable");
});

test("operations disable channels and actions; the download exposes real byte progress", () => {
  const html = renderToStaticMarkup(
    <UpdateDetails
      update={{
        desktop: true,
        state: { ...state("downloading"), downloaded: 42, total: 100 },
        pending: false,
        act: async () => {},
      }}
    />,
  );
  const buttons = html.match(/<button[^>]*>/g)!;
  expect(buttons.length).toBeGreaterThan(3);
  expect(buttons.every((button) => /\sdisabled(?:=|\s|>)/.test(button))).toBe(
    true,
  );
  expect(html).toMatch(/<progress[^>]*value="42"[^>]*max="100"/);
  const ready = renderToStaticMarkup(
    <UpdateDetails
      update={{
        desktop: true,
        state: state("ready"),
        pending: false,
        act: async () => {},
      }}
    />,
  );
  expect(ready).not.toMatch(/\sdisabled(?:=|\s|>)/);
  expect(ready).toContain('aria-checked="true"');
});

test("browser views do not offer a desktop installer for their kernel", () => {
  expect(renderToStaticMarkup(<UpdateButton />)).toBe("");
  expect(renderToStaticMarkup(<UpdateSettings />)).toBe("");
});

test("a failed check without a candidate does not advertise an update in the header", () => {
  const update = {
    desktop: true,
    pending: false,
    act: async () => {},
    state: {
      ...state(),
      phase: "error" as const,
      error: "Update signing key is not configured",
    },
  };
  expect(renderToStaticMarkup(<UpdateControl update={update} />)).toBe("");
  expect(renderToStaticMarkup(<UpdateDetails update={update} />)).toContain(
    'role="alert"',
  );
  expect(
    renderToStaticMarkup(
      <UpdateControl update={{ ...update, state: state("ready") }} />,
    ),
  ).toContain('aria-haspopup="dialog"');
});
