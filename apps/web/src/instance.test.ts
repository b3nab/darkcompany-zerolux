import { afterAll, afterEach, expect, test } from "bun:test";
import type { AuthHealth, ServedWorkspace } from "@zerolux/chat";
import { arrive, filesIn, invitedTo, place, WORKSPACES_PAGE } from "./instance";

const kernel = "http://192.0.2.10:4310";
const served = (...names: string[]): ServedWorkspace[] =>
  names.map((name) => ({
    id: name,
    name,
    base: `${kernel}/w/${name}`,
    owner: true,
  }));
const older: ServedWorkspace[] = [
  { id: "aspen", name: "aspen", base: kernel, owner: true },
];

const kept = new Map<string, string>();
const storage = globalThis.localStorage;
globalThis.localStorage = {
  getItem: (key: string) => kept.get(key) ?? null,
  setItem: (key: string, value: string) => void kept.set(key, value),
} as Storage;
afterEach(() => kept.clear());
afterAll(() => {
  globalThis.localStorage = storage;
});

test("an older kernel's one workspace is at its root", () => {
  expect(place("/chats", "", older, false)).toEqual({
    workspace: older[0]!,
    basename: "",
    address: undefined,
  });
  // A page address of a newer kernel, opened on an older one, loses its workspace.
  expect(place("/w/aspen/chats", "", older, false)).toMatchObject({
    address: "/chats",
  });
});

test("the address names the workspace, and one the account is not in is not entered", () => {
  const workspaces = served("aspen", "birch");
  expect(place("/w/birch/chats/1", "", workspaces, true)).toEqual({
    workspace: workspaces[1]!,
    basename: "/w/birch",
    address: undefined,
  });
  expect(place("/w/cedar/chats", "", workspaces, true)).toEqual({
    choose: { creating: false },
  });
});

test("at the root, the workspace chosen last or the only one opens, else they are listed", () => {
  expect(place("/chats/1", "", served("aspen"), true)).toMatchObject({
    basename: "/w/aspen",
    address: "/w/aspen/chats/1",
  });
  const two = served("aspen", "birch");
  expect(place("/", "", two, true)).toEqual({ choose: { creating: false } });
  expect(place("/", "", two, true, "birch")).toMatchObject({
    basename: "/w/birch",
  });
  // An account without workspaces makes its first one.
  expect(place("/", "", [], true)).toEqual({ choose: { creating: true } });
  expect(place(WORKSPACES_PAGE, "", two, true, "birch")).toEqual({
    choose: { creating: false },
  });
  expect(place(WORKSPACES_PAGE, "?new", two, true)).toEqual({
    choose: { creating: true },
  });
});

test("a join link names its workspace and its invitation", () => {
  expect(invitedTo("/w/birch/join", "?invite=token")).toEqual({
    workspace: "birch",
    token: "token",
  });
  expect(invitedTo("/join", "?invite=token")).toEqual({
    workspace: undefined,
    token: "token",
  });
  expect(invitedTo("/w/birch/join", "")).toBeUndefined();
  expect(invitedTo("/w/birch/chats", "?invite=token")).toBeUndefined();
});

/** A kernel's sign-in, as `arrive` asks it, with the calls it was asked. */
function gate({
  multi = true,
  account = true,
  setup = false,
  member = true,
  names = ["aspen", "birch"],
}: {
  multi?: boolean;
  account?: boolean;
  setup?: boolean;
  member?: boolean;
  names?: string[];
} = {}) {
  const calls: string[] = [];
  const health: AuthHealth = multi
    ? {
        api_version: 2,
        capabilities: ["workspaces-v1", "instance-auth-v1"],
        instance: { id: "instance" },
        auth: { setup_required: false },
      }
    : {
        api_version: 2,
        capabilities: ["auth-v1"],
        workspace: { id: "aspen", name: "aspen" },
        auth: { setup_required: setup },
      };
  const user = { id: "u", name: "Owner", email: "owner@example.test" };
  let joined = member;
  return {
    calls,
    connection: {
      kernel,
      async restore() {
        return {
          health,
          identity: account ? { user, setup_required: false } : null,
        };
      },
      async workspaces() {
        return multi ? served(...names) : older;
      },
      async identity(base: string) {
        calls.push(`identity ${base}`);
        return {
          user,
          setup_required: setup,
          actor_id: joined ? "actor" : null,
          owner: joined,
        };
      },
      async claim(base: string, invite?: string) {
        calls.push(`claim ${base} ${invite ?? ""}`.trim());
        joined = true;
        return { user, setup_required: false, actor_id: "actor", owner: true };
      },
      async invitation(base: string, token: string) {
        calls.push(`invitation ${base} ${token}`);
        return { workspace: "birch", invited_by: "Owner", expires_at: 0 };
      },
    } as unknown as Parameters<typeof arrive>[0],
  };
}

test("without a sign-in the page signs in first, an invitation shown with it", async () => {
  const { connection, calls } = gate({ account: false });
  expect((await arrive(connection, "/", "", undefined)).stage.kind).toBe(
    "sign-in",
  );
  const invited = await arrive(
    connection,
    "/w/birch/join",
    "?invite=t",
    invitedTo("/w/birch/join", "?invite=t"),
  );
  expect(invited.stage).toMatchObject({
    kind: "sign-in",
    invitation: { workspace: "birch" },
  });
  expect(calls).toEqual([`invitation ${kernel}/w/birch t`]);
});

test("signed in, the account's workspace opens, or the list when several", async () => {
  const { connection } = gate();
  expect((await arrive(connection, "/", "", undefined)).stage.kind).toBe(
    "choose",
  );
  const opened = await arrive(connection, "/w/birch/chats", "", undefined);
  expect(opened.stage).toMatchObject({
    kind: "in",
    workspace: { id: "birch" },
    basename: "/w/birch",
  });
  expect(opened.address).toBeUndefined();
  const remembered = await arrive(connection, "/", "", undefined, "aspen");
  expect(remembered).toMatchObject({
    stage: { kind: "in", workspace: { id: "aspen" } },
    address: "/w/aspen/",
  });
});

test("a join link's invitation is claimed in its workspace, which then opens", async () => {
  const { connection, calls } = gate({ member: false });
  const joined = await arrive(
    connection,
    "/w/birch/join",
    "?invite=t",
    invitedTo("/w/birch/join", "?invite=t"),
  );
  expect(calls[0]).toBe(`claim ${kernel}/w/birch t`);
  expect(joined).toMatchObject({
    stage: { kind: "in", workspace: { id: "birch" } },
    address: "/w/birch/",
  });
});

test("an account that is not a member of a workspace does not enter it", async () => {
  const { connection } = gate({ member: false });
  expect(
    (await arrive(connection, "/w/aspen/", "", undefined)).stage,
  ).toMatchObject({ kind: "choose", outside: { id: "aspen" } });
});

test("an older kernel's first account becomes its workspace's owner", async () => {
  const { connection, calls } = gate({
    multi: false,
    setup: true,
    member: false,
  });
  const arrived = await arrive(connection, "/chats", "", undefined);
  expect(arrived.stage).toMatchObject({ kind: "in", basename: "" });
  expect(calls).toEqual([`identity ${kernel}`, `claim ${kernel}`]);
});

test("a workspace keeps its files in the .zerolux of the folder chosen", () => {
  expect(filesIn("/tmp/aspen")).toBe("/tmp/aspen/.zerolux");
  expect(filesIn("/tmp/aspen/")).toBe("/tmp/aspen/.zerolux");
  expect(filesIn("/tmp/aspen/.zerolux")).toBe("/tmp/aspen/.zerolux");
  expect(filesIn("C:\\Projects\\aspen")).toBe("C:\\Projects\\aspen\\.zerolux");
});
