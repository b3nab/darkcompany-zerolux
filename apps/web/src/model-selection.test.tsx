import { afterAll, afterEach, expect, test } from "bun:test";
import { act, type ReactNode } from "react";
import { Window } from "happy-dom";
import type {
  Actor,
  AgentSettings,
  Chat,
  ChatSession,
  LiveRead,
  NewSession,
} from "@zerolux/chat";

// `bun run test` uses --parallel: every file has its own globals and module registry.
// Bun 1.4.2 has no DOM environment flag. Install one before loading React DOM or Base UI.
const browser = new Window({ url: "https://fixture.example.test" });
const globals = {
  window: browser,
  document: browser.document,
  navigator: browser.navigator,
  Node: browser.Node,
  NodeFilter: browser.NodeFilter,
  Element: browser.Element,
  HTMLElement: browser.HTMLElement,
  HTMLInputElement: browser.HTMLInputElement,
  HTMLButtonElement: browser.HTMLButtonElement,
  HTMLIFrameElement: browser.HTMLIFrameElement,
  SVGElement: browser.SVGElement,
  ShadowRoot: browser.ShadowRoot,
  Document: browser.Document,
  DocumentFragment: browser.DocumentFragment,
  Event: browser.Event,
  MouseEvent: browser.MouseEvent,
  KeyboardEvent: browser.KeyboardEvent,
  PointerEvent: browser.PointerEvent,
  InputEvent: browser.InputEvent,
  FocusEvent: browser.FocusEvent,
  MutationObserver: browser.MutationObserver,
  ResizeObserver: browser.ResizeObserver,
  getComputedStyle: browser.getComputedStyle.bind(browser),
  requestAnimationFrame: browser.requestAnimationFrame.bind(browser),
  cancelAnimationFrame: browser.cancelAnimationFrame.bind(browser),
  IS_REACT_ACT_ENVIRONMENT: true,
};
const previous = new Map(
  Object.keys(globals).map((key) => [
    key,
    Object.getOwnPropertyDescriptor(globalThis, key),
  ]),
);
for (const [key, value] of Object.entries(globals))
  Object.defineProperty(globalThis, key, {
    configurable: true,
    writable: true,
    value,
  });

const { createRoot } = await import("react-dom/client");
const {
  liveNotice,
  lookWith,
  setKernelFetch,
  useSessionSettings,
  useSessionUsage,
} = await import("@zerolux/chat");
const { ModelSelect } = await import("./components/model-select");
const { AgentSettingsForm, StartSession } = await import("./Team");
const { ContextMeter, SessionSettings } = await import("./Console");
type Settings = ReturnType<typeof useSessionSettings>;
let root: ReturnType<typeof createRoot> | undefined;
let settings: Settings;

afterEach(async () => {
  await act(async () => root?.unmount());
  root = undefined;
  document.body.replaceChildren();
  setKernelFetch();
  lookWith(
    () => true,
    () => {},
  );
});
afterAll(async () => {
  await browser.happyDOM.abort();
  for (const [key, descriptor] of previous) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});

const snapshot = (model: string) => ({
  values: { model, effort: null },
  models: [{ value: "native-known", label: "Fixture", efforts: [] }],
  editable: ["model"],
});

function Probe({
  id = "a",
  picker = false,
  disabled = false,
}: {
  id?: string;
  picker?: boolean;
  disabled?: boolean;
}) {
  settings = useSessionSettings(id, "", "https://fixture.example.test");
  return picker ? (
    <ModelSelect
      value={settings.data?.values.model ?? ""}
      models={settings.data?.models ?? []}
      custom
      disabled={disabled}
      onOpen={settings.refresh}
      onChange={(model) => {
        void settings.apply({ model });
      }}
    />
  ) : null;
}

async function render(node: ReactNode) {
  if (!root) {
    const container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  }
  await act(async () => root!.render(node));
}

async function openPicker(selector = "button") {
  await act(async () =>
    document.querySelector<HTMLButtonElement>(selector)!.click(),
  );
  const input = document.querySelector<HTMLInputElement>(
    'input[role="combobox"]',
  );
  expect(input).not.toBeNull();
  return input!;
}

async function type(input: HTMLInputElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function key(input: HTMLInputElement, key: string) {
  await act(async () => {
    input.dispatchEvent(
      new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }),
    );
  });
}

test("typing and cancelling keep the model; Enter and selecting submit one confirmed change", async () => {
  let model = "native-known";
  const changes: unknown[] = [];
  setKernelFetch(async (_url, init) => {
    if (init?.method === "PATCH") {
      const change = JSON.parse(String(init.body)) as { model: string };
      changes.push(change);
      model = change.model;
    }
    return Response.json(snapshot(model));
  });
  await render(<Probe picker />);
  let input = await openPicker();
  await type(input, "native-cancelled");
  expect(changes).toHaveLength(0);
  await key(input, "Escape");
  expect(changes).toHaveLength(0);
  expect(settings.data?.values.model).toBe("native-known");

  input = await openPicker();
  await type(input, "native-new");
  expect(changes).toHaveLength(0);
  await key(input, "Enter");
  expect(changes).toEqual([{ model: "native-new" }]);
  expect(settings.data?.values.model).toBe("native-new");

  await openPicker();
  await act(async () => {
    document
      .querySelector<HTMLElement>('[role="option"][data-value="native-known"]')!
      .click();
  });
  expect(changes).toEqual([{ model: "native-new" }, { model: "native-known" }]);
  expect(settings.data?.values.model).toBe("native-known");
});

test("a concrete model stays selected when the default resolves to the same ID", async () => {
  const models = [
    {
      value: "default",
      label: "Fixture reset",
      resolved_model: "native-version",
      efforts: [],
    },
    {
      value: "family",
      label: "Fixture family",
      resolved_model: "native-version",
      efforts: [],
    },
    { value: "native-known", label: "Fixture previous", efforts: [] },
  ];
  let model = "native-known";
  let reads = 0;
  const changes: AgentSettings[] = [];
  setKernelFetch(async (_url, init) => {
    if (init?.method === "PATCH") {
      const change = JSON.parse(String(init.body)) as AgentSettings;
      changes.push(change);
      model = "native-version";
    } else reads++;
    return Response.json({ ...snapshot(model), models });
  });
  const selected = () =>
    [...document.querySelectorAll('[role="option"][data-checked="true"]')].map(
      (option) => option.getAttribute("data-value"),
    );
  const picker = <Probe id="resolved-model-choice" picker />;
  await render(picker);
  await openPicker();
  expect(selected()).toEqual(["native-known"]);
  await act(async () => {
    document
      .querySelector<HTMLElement>('[role="option"][data-value="family"]')!
      .click();
  });
  expect(changes).toEqual([{ model: "family" }]);
  expect(settings.data?.values.model).toBe("native-version");
  await openPicker();
  expect(selected()).toEqual(["family"]);
  const before = reads;
  await act(async () => settings.refresh());
  expect(reads).toBeGreaterThan(before);
  expect(selected()).toEqual(["family"]);
  await render(null);
  await render(picker);
  await openPicker();
  expect(selected()).toEqual(["family"]);
  expect(settings.data?.values.model).toBe("native-version");
  expect(changes).toEqual([{ model: "family" }]);
});

test("a confirmed model's usage updates the context meter without a new turn", async () => {
  const id = "context-change";
  const usage = {
    context_tokens: 42_000,
    context_window: 200_000,
    total_tokens: null,
    cost_usd: null,
  };
  const read = async (): Promise<LiveRead> => ({ seq: 1, items: [], usage });
  function ContextProbe() {
    const reported = useSessionUsage(id, read);
    return (
      <>
        <Probe id={id} picker />
        <ContextMeter usage={reported} />
      </>
    );
  }
  const changes: unknown[] = [];
  let model = "native-known";
  setKernelFetch(async (_url, init) => {
    if (init?.method === "PATCH") {
      const change = JSON.parse(String(init.body)) as { model: string };
      changes.push(change);
      model = change.model;
      liveNotice({
        type: "session.live",
        session_id: id,
        first: 2,
        changes: [{ type: "usage", ...usage, context_window: 1_000_000 }],
      });
    }
    return Response.json(snapshot(model));
  });
  await render(<ContextProbe />);
  const meter = () =>
    document.querySelector('[role="meter"]')?.getAttribute("aria-valuenow");
  expect(meter()).toBe("21");
  const input = await openPicker();
  await type(input, "native-new");
  expect(meter()).toBe("21");
  await key(input, "Enter");
  expect(changes).toEqual([{ model: "native-new" }]);
  expect(settings.data?.values.model).toBe("native-new");
  expect(meter()).toBe("4");
});

test("disabling an open model picker prevents both keyboard and pointer changes", async () => {
  const changes: unknown[] = [];
  setKernelFetch(async (_url, init) => {
    if (init?.method === "PATCH") changes.push(JSON.parse(String(init.body)));
    return Response.json(snapshot("native-known"));
  });
  await render(<Probe picker />);
  const input = await openPicker();
  await type(input, "native-new");
  await render(<Probe picker disabled />);
  await key(input, "Enter");
  await act(async () => {
    document
      .querySelector<HTMLElement>('[role="option"][data-value="native-new"]')!
      .click();
  });
  expect(changes).toHaveLength(0);
  expect(settings.data?.values.model).toBe("native-known");
});

test("new sessions can keep native defaults or submit a confirmed custom model", async () => {
  const started: NewSession[] = [];
  setKernelFetch(async () => Response.json(snapshot("native-known")));
  const chat = {
    createSession: async (input: NewSession) => {
      started.push(input);
      return { actor: null, session: { id: "new" } as ChatSession };
    },
  } as Chat;
  await render(
    <StartSession
      chat={chat}
      actors={[]}
      folders={[]}
      busy={false}
      perform={async (action) => {
        await action();
        return true;
      }}
      agent="none"
      heading="Fixture"
      ready={() => true}
    />,
  );
  const folder = document.querySelector<HTMLInputElement>("#start-folder")!;
  const form = document.querySelector("form")!;
  await type(folder, "/fixture/project");
  await act(async () => form.requestSubmit());
  expect(started).toHaveLength(1);
  expect(started[0]).toMatchObject({
    workspace: "/fixture/project",
    harness: "claude-code",
  });
  expect(started[0]).not.toHaveProperty("model");
  expect(started[0]).not.toHaveProperty("effort");

  await type(folder, "/fixture/project");
  const input = await openPicker("#start-model");
  await type(input, "native-new");
  expect(started).toHaveLength(1);
  await key(input, "Enter");
  expect(started).toHaveLength(1);
  await act(async () => form.requestSubmit());
  expect(started).toHaveLength(2);
  expect(started[1]).toMatchObject({
    workspace: "/fixture/project",
    model: "native-new",
  });
  expect(started[1]).not.toHaveProperty("effort");
});

const configuredAgent = {
  id: "fixture-agent",
  name: "Fixture",
  kind: "agent",
  owner_id: "fixture-owner",
  invited_by: null,
  harness: "claude-code",
  model: "fixture-model",
  effort: "high",
  permission_mode: "plan",
  approval_policy: null,
  sandbox: null,
  created_at: 0,
  archived: false,
} satisfies Actor;
const agentSnapshot = (actor: Actor) => ({
  actor,
  models: snapshot("native-known").models,
  editable: ["model", "effort", "permission_mode"],
});

test("agent settings retain reported values while loading and save only a confirmed model", async () => {
  let actor: Actor = configuredAgent;
  let loaded = false;
  let finish!: (response: Response) => void;
  const changes: AgentSettings[] = [];
  setKernelFetch(async () =>
    loaded
      ? Response.json(agentSnapshot(actor))
      : new Promise<Response>((resolve) => {
          finish = resolve;
        }),
  );
  await render(
    <AgentSettingsForm
      agent={configuredAgent}
      busy={false}
      save={async (change) => {
        changes.push(change);
        actor = { ...actor, ...change };
        return actor;
      }}
    />,
  );
  const model = document.querySelector<HTMLButtonElement>(
    "#agent-setting-model",
  )!;
  expect(model.textContent).toBe(configuredAgent.model);
  expect(model.disabled).toBe(true);
  expect(
    document.querySelector<HTMLSelectElement>("#agent-setting-effort")!.value,
  ).toBe("high");
  expect(
    document.querySelector<HTMLSelectElement>("#agent-setting-permission_mode")!
      .value,
  ).toBe("plan");
  await act(async () => {
    loaded = true;
    finish(Response.json(agentSnapshot(actor)));
  });
  expect(model.disabled).toBe(false);
  expect(model.textContent).toBe(configuredAgent.model);
  const input = await openPicker("#agent-setting-model");
  await type(input, "native-new");
  expect(changes).toHaveLength(0);
  await key(input, "Enter");
  expect(changes).toHaveLength(0);
  await act(async () => document.querySelector("form")!.requestSubmit());
  expect(changes).toEqual([{ model: "native-new" }]);
  expect(model.textContent).toBe("native-new");
});

test("busy agent settings preserve unknown values and prevent editing or submitting", async () => {
  const actor = { ...configuredAgent, permission_mode: "future-mode" };
  const changes: AgentSettings[] = [];
  setKernelFetch(async () => Response.json(agentSnapshot(actor)));
  await render(
    <AgentSettingsForm
      agent={actor}
      busy
      save={async (change) => {
        changes.push(change);
        return actor;
      }}
    />,
  );
  const form = document.querySelector("form")!;
  for (const control of form.querySelectorAll<
    HTMLButtonElement | HTMLSelectElement
  >("button, select"))
    expect(control.disabled).toBe(true);
  expect(
    document.querySelector<HTMLSelectElement>("#agent-setting-permission_mode")!
      .value,
  ).toBe("future-mode");
  await act(async () =>
    document.querySelector<HTMLButtonElement>("#agent-setting-model")!.click(),
  );
  expect(document.querySelector('input[role="combobox"]')).toBeNull();
  await act(async () => form.requestSubmit());
  expect(changes).toHaveLength(0);
});

const settingsSession = {
  id: "fixture-session",
  harness: "claude-code",
  status: "connected",
  activity: "idle",
} as ChatSession;

test("a refused change is shown in its settings panel without retrying the PATCH", async () => {
  const calls: string[] = [];
  setKernelFetch(async (_url, init) => {
    calls.push(init?.method ?? "GET");
    if (init?.method === "PATCH")
      return Response.json({ error: "Fixture refusal" }, { status: 400 });
    return Response.json(snapshot("native-known"));
  });
  await render(<SessionSettings session={settingsSession} />);
  await act(async () =>
    document.querySelector<HTMLButtonElement>("button")!.click(),
  );
  const input = await openPicker('[role="group"] button');
  await type(input, "native-new");
  await key(input, "Enter");
  const group = document.querySelector<HTMLElement>('[role="group"]')!;
  expect(group.querySelector('[role="alert"]')).not.toBeNull();
  expect(group.getAttribute("aria-busy")).toBe("false");
  expect(calls.filter((method) => method === "PATCH")).toHaveLength(1);
  await act(async () =>
    group.querySelector<HTMLButtonElement>('[role="alert"] + button')!.click(),
  );
  expect(group.querySelector('[role="alert"]')).toBeNull();
  expect(calls.filter((method) => method === "PATCH")).toHaveLength(1);
  expect(calls.at(-1)).toBe("GET");
});

test("the picker keeps its confirmed value and disables controls while a change reconnects the session", async () => {
  let finish!: (response: Response) => void;
  setKernelFetch(async (_url, init) =>
    init?.method === "PATCH"
      ? new Promise<Response>((resolve) => {
          finish = resolve;
        })
      : Response.json(snapshot("native-known")),
  );
  await render(<SessionSettings session={settingsSession} />);
  await act(async () =>
    document.querySelector<HTMLButtonElement>("button")!.click(),
  );
  const input = await openPicker('[role="group"] button');
  const group = document.querySelector<HTMLElement>('[role="group"]')!;
  const model = group.querySelector<HTMLButtonElement>("button")!;
  const confirmed = model.textContent;
  await type(input, "native-new");
  await key(input, "Enter");
  expect(model.textContent).toBe(confirmed);
  expect(model.disabled).toBe(true);
  expect(group.getAttribute("aria-busy")).toBe("true");
  await render(
    <SessionSettings session={{ ...settingsSession, status: "connecting" }} />,
  );
  expect(document.querySelector('[role="group"]')).not.toBeNull();
  await act(async () => finish(Response.json(snapshot("native-new"))));
  expect(model.textContent).toBe("native-new");
  expect(group.getAttribute("aria-busy")).toBe("false");
  expect(model.disabled).toBe(true);
});

test("a failed settings read keeps a working refresh control accessible", async () => {
  let available = false;
  setKernelFetch(async () =>
    available
      ? Response.json(snapshot("native-known"))
      : Response.json({ error: "Fixture unavailable" }, { status: 503 }),
  );
  await render(<SessionSettings session={settingsSession} />);
  await act(async () =>
    document.querySelector<HTMLButtonElement>("button")!.click(),
  );
  const group = document.querySelector<HTMLElement>('[role="group"]')!;
  expect(group.querySelector('[role="alert"]')).not.toBeNull();
  expect(group.querySelector<HTMLButtonElement>("button")!.disabled).toBe(true);
  available = true;
  await act(async () =>
    group.querySelector<HTMLButtonElement>('[role="alert"] + button')!.click(),
  );
  expect(group.querySelector('[role="alert"]')).toBeNull();
  expect(group.querySelector<HTMLButtonElement>("button")!.disabled).toBe(
    false,
  );
});

test("an uncertain PATCH observes actual settings once without replaying", async () => {
  const calls: string[] = [];
  let model = "native-known";
  setKernelFetch(async (_url, init) => {
    calls.push(init?.method ?? "GET");
    if (init?.method === "PATCH") {
      model = "native-new";
      return Response.json(
        { error: "Fixture unconfirmed", code: "session_settings_unconfirmed" },
        { status: 504 },
      );
    }
    return Response.json(snapshot(model));
  });
  await render(<Probe />);
  await act(async () => {
    await settings.apply({ model: "native-new" }).catch(() => {});
  });
  expect(calls).toEqual(["GET", "PATCH", "GET"]);
  expect(settings.data?.values.model).toBe("native-new");
  expect(settings.pending).toBe(false);
  expect(calls).toEqual(["GET", "PATCH", "GET"]);
});

function pendingKernel() {
  const pending: {
    url: string;
    method: string;
    finish(model: string): void;
  }[] = [];
  setKernelFetch(
    (url, init) =>
      new Promise<Response>((resolve) => {
        pending.push({
          url,
          method: init?.method ?? "GET",
          finish: (model) => resolve(Response.json(snapshot(model))),
        });
      }),
  );
  return {
    pending,
    finish: (index: number, model: string) =>
      act(async () => pending[index]!.finish(model)),
  };
}

test("returning to a session with a pending change follows that operation without sending another PATCH", async () => {
  const { pending, finish } = pendingKernel();
  await render(<Probe id="a" />);
  await finish(0, "native-a");
  let first!: Promise<unknown>;
  await act(async () => {
    first = settings.apply({ model: "native-new-a" });
  });
  await render(<Probe id="b" />);
  await finish(2, "native-b");
  let other!: Promise<unknown>;
  await act(async () => {
    other = settings.apply({ model: "native-new-b" });
  });
  await render(<Probe id="a" />);
  expect(settings.pending).toBe(true);
  let duplicate!: Promise<unknown>;
  await act(async () => {
    duplicate = settings.apply({ model: "native-new-a" });
  });
  expect(pending.map(({ method }) => method)).toEqual([
    "GET",
    "PATCH",
    "GET",
    "PATCH",
    "GET",
  ]);
  await finish(1, "native-new-a");
  await finish(4, "native-a");
  await finish(3, "native-new-b");
  await Promise.all([first, duplicate, other]);
  expect(settings.pending).toBe(false);
  expect(settings.loading).toBe(false);
  expect(settings.data?.values.model).toBe("native-new-a");
});

test("remounting a session keeps its pending operation and confirmed result", async () => {
  const { pending, finish } = pendingKernel();
  await render(<Probe />);
  await finish(0, "native-old");
  let first!: Promise<unknown>;
  await act(async () => {
    first = settings.apply({ model: "native-new" });
  });
  await render(null);
  await render(<Probe />);
  expect(settings.pending).toBe(true);
  let duplicate!: Promise<unknown>;
  await act(async () => {
    duplicate = settings.apply({ model: "native-new" });
  });
  expect(pending.map(({ method }) => method)).toEqual(["GET", "PATCH", "GET"]);
  await finish(1, "native-new");
  await finish(2, "native-old");
  await Promise.all([first, duplicate]);
  expect(settings.pending).toBe(false);
  expect(settings.loading).toBe(false);
  expect(settings.data?.values.model).toBe("native-new");
});

test("a foreground read started before a PATCH confirmation cannot undo that confirmation", async () => {
  const { pending, finish } = pendingKernel();
  let foreground = true;
  let changed = () => {};
  lookWith(
    () => foreground,
    (listener) => {
      changed = listener;
    },
  );
  await render(<Probe />);
  await finish(0, "native-old");
  let applying: Promise<unknown>;
  await act(async () => {
    applying = settings.apply({ model: "native-new" });
  });
  await act(async () => {
    foreground = false;
    changed();
  });
  expect(pending).toHaveLength(2);
  await act(async () => {
    foreground = true;
    changed();
  });
  expect(pending.map(({ method }) => method)).toEqual(["GET", "PATCH", "GET"]);
  await finish(1, "native-new");
  await applying!;
  await finish(2, "native-old");
  expect(settings.data?.values.model).toBe("native-new");
  expect(settings.loading).toBe(false);
});

test("a previous session's delayed PATCH does not invalidate the next session's read", async () => {
  const { pending, finish } = pendingKernel();
  await render(<Probe id="a" />);
  await finish(0, "native-a");
  let applying: Promise<unknown>;
  await act(async () => {
    applying = settings.apply({ model: "native-new-a" });
  });
  await render(<Probe id="b" />);
  expect(new URL(pending[2]!.url).pathname).toBe("/api/sessions/b/settings");
  await finish(1, "native-new-a");
  await applying!;
  await finish(2, "native-b");
  expect(settings.data?.values.model).toBe("native-b");
  expect(settings.loading).toBe(false);
});
