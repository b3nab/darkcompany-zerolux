import { fileURLToPath } from "node:url";
import { expect, test } from "bun:test";
import {
  appendFile,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import {
  ChatHttpError,
  LocalControl,
  nativeFingerprint,
  type ChatRequest,
  type Inbox,
} from "@zerolux/bridge";
import { savePiProfile } from "./execution-profile.ts";
import { PiExecutionLease, processExists } from "./execution-lease.ts";
import { PiRunner } from "./runner.ts";

async function fixture(
  fault = "",
  options: { extensionControl?: boolean } = {},
) {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "zerolux-pi-runner-")),
  );
  const agent = join(root, "agent");
  await mkdir(agent);
  const env = {
    HOME: root,
    PATH: [dirname(process.execPath), "/usr/bin", "/bin"].join(delimiter),
    TMPDIR: root,
    FAKE_PI_ROOT: root,
    FAKE_PI_FAULT: fault,
    ...(options.extensionControl ? { FAKE_PI_EXTENSION_CONTROL: "1" } : {}),
  };
  // A real, certainly exited fixture PID, never a personal harness.
  const old = Bun.spawn([process.execPath, "-e", ""], {
    env,
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
  });
  await old.exited;
  const manager = SessionManager.create(root, join(root, "sessions"));
  if (!fault.startsWith("create")) {
    manager.appendModelChange("fixture", "native-model");
    manager.appendThinkingLevelChange("high");
  }
  const file = manager.getSessionFile()!;
  const bytes =
    [manager.getHeader(), ...manager.getEntries()]
      .map((entry) => JSON.stringify(entry))
      .join("\n") + "\n";
  await writeFile(file, bytes, { flag: "wx", mode: 0o600 });
  const profile = await savePiProfile({
    version: 1,
    nativeSessionId: manager.getSessionId(),
    file,
    workspace: root,
    agentDir: agent,
    cliVersion: "0.87.1",
    lastPid: old.pid,
    args: [],
  });
  const script = join(root, "pi-fixture");
  await writeFile(
    script,
    `#!${process.execPath}
import { appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
if (process.argv.includes("--version")) { console.log("0.87.1"); process.exit(0); }
const root = process.env.FAKE_PI_ROOT;
appendFileSync(join(root, "starts"), (process.env.ZEROLUX_NATIVE_PID ?? process.pid) + "\\n");
const option = name => { const i = process.argv.indexOf(name); return i < 0 ? undefined : process.argv[i + 1]; };
const file = option("--session");
const header = JSON.parse(readFileSync(file, "utf8").split("\\n")[0]);
if (process.env.FAKE_PI_FAULT === "create") {
  const { SessionManager } = await import(${JSON.stringify(import.meta.resolve("@earendil-works/pi-coding-agent"))});
  const manager = SessionManager.open(file);
  manager.appendModelChange("fixture", "native-model"); manager.appendThinkingLevelChange("high");
}
const { readControlDescriptor, controlRequest } = await import(${JSON.stringify(fileURLToPath(new URL("../../../packages/bridge/src/control-client.ts", import.meta.url)))});
const descriptor = await readControlDescriptor(process.env.ZEROLUX_PI_RUNNER);
if (process.env.FAKE_PI_FAULT !== "unguarded") await controlRequest(descriptor, "verify", { native_pid:Number(process.env.ZEROLUX_NATIVE_PID ?? process.pid), session_file:file, cli_version:"0.87.1", model:{provider:option("--provider") ?? "fixture",id:option("--model") ?? "native-model"}, thinking:option("--thinking") ?? "high", auth_configured:true });
// The native extension's own control, as stock pi's chat extension runs it: asked whose
// turn it is, it answers what the test left in "turn" (a JSON value), or refuses.
if (process.env.FAKE_PI_EXTENSION_CONTROL) {
  const { LocalControl } = await import(${JSON.stringify(fileURLToPath(new URL("../../../packages/bridge/src/local-control.ts", import.meta.url)))});
  const { existsSync } = await import("node:fs");
  const control = new LocalControl(join(root, "ext-control"), {
    describe: () => ({ kind: "pi", native_session_id: header.id, workspace: process.cwd() }),
    handle: async (method) => {
      if (method !== "turn") throw new Error("Unknown");
      const delay = join(root, "turn-delay");
      if (existsSync(delay)) await Bun.sleep(Number(readFileSync(delay, "utf8")));
      const turn = join(root, "turn");
      if (!existsSync(turn)) throw new Error("Not now");
      return JSON.parse(readFileSync(turn, "utf8"));
    },
  }, "fixture-ext");
  await control.start();
  await controlRequest(descriptor, "links", { native_pid: Number(process.env.ZEROLUX_NATIVE_PID ?? process.pid), link_ids: ["link"], control: join(root, "ext-control", control.instanceId + ".json") });
  appendFileSync(join(root, "linked"), "1\\n");
}
let buffer = "";
process.stdin.on("data", bytes => {
  buffer += bytes; let end;
  while ((end = buffer.indexOf("\\n")) >= 0) {
    const request = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1);
    appendFileSync(join(root, "commands"), request.type + "\\n");
    if (request.type === "extension_ui_response") { appendFileSync(join(root, "answers"), JSON.stringify(request) + "\\n"); continue; }
    if (request.type !== "get_state") { console.error("Forbidden native input"); process.exit(8); }
    if (process.env.FAKE_PI_FAULT === "silent") continue;
    console.log(JSON.stringify({ type: "response", id: request.id, success: true, data: {
      sessionId: header.id, sessionFile: file,
      model: { provider: option("--provider") ?? "fixture", id: ["model", "persistence"].includes(process.env.FAKE_PI_FAULT) ? "wrong-model" : option("--model") ?? "native-model" },
      thinkingLevel: option("--thinking") ?? "high", messageCount: 0, isStreaming: false,
    } }));
  }
});
process.stdin.on("end", () => process.exit(0));
// An append-only queue preserves native event order. A truncating/unlinked mailbox
// can lose a request while the parent writes it, or overwrite a preceding event.
import { existsSync } from "node:fs";
let consumed = 0;
setInterval(() => {
  const ask = join(root, "ask");
  if (!existsSync(ask)) return;
  const requests = readFileSync(ask, "utf8");
  const end = requests.lastIndexOf("\\n") + 1;
  if (end > consumed) { process.stdout.write(requests.slice(consumed, end)); consumed = end; }
}, 50);
`,
    { mode: 0o700 },
  );
  // Windows runs a script through a command file, as npm installs pi there.
  const pi = process.platform === "win32" ? `${script}.cmd` : script;
  if (process.platform === "win32")
    await writeFile(pi, `@"${process.execPath}" "${script}" %*\r\n`);
  const inbox: Inbox = {
    session: {
      id: "link",
      actor_id: "actor",
      harness: "pi",
      native_session_id: manager.getSessionId(),
      workspace: root,
      status: "connecting",
    },
    workspace: { id: "company", name: "Fixture" },
    conversations: [],
    deliveries: [],
  };
  let calls = 0;
  let beforeRead = async (_call: number) => {};
  const approvals: Record<string, unknown>[] = [];
  const kernelCalls: { path: string; body?: unknown }[] = [];
  let validToken = "fixture";
  const runner = new PiRunner(
    {
      nativeSessionId: manager.getSessionId(),
      workspace: root,
      file,
      profile,
      pi,
      entry: join(import.meta.dir, "runner.ts"),
      creation: fault.startsWith("create"),
    },
    {
      alive: processExists,
      environment: () => env,
      persistProfile: (profile) =>
        fault === "persistence"
          ? Promise.reject(new Error("Fixture profile storage is unavailable"))
          : savePiProfile(profile),
      connect: (_base, token) =>
        (async (path: string, body?: unknown) => {
          // A token the kernel revoked (a rebind issued another) is refused everywhere.
          if (token !== validToken) throw new ChatHttpError(401);
          if (path !== "/chat/inbox") {
            // The kernel's approvals, as the host uses them for pi's questions.
            kernelCalls.push({ path, body });
            const found = (id: string) => approvals.find((a) => a.id === id);
            if (path === "/chat/approvals") {
              const input = body as Record<string, unknown>;
              if (![null, "turn-delivery"].includes(input.delivery_id as never))
                throw new Error("Unknown delivery");
              approvals.push({ ...input, status: "pending", decision: null });
              return {};
            }
            const match = path.match(
              /^\/chat\/approvals\/([^/]+)\/(dispatch|receipt)$/,
            );
            if (match) {
              const approval = found(match[1]!)!;
              if (match[2] === "dispatch") {
                if (approval.status !== "decided") throw new Error("Conflict");
                approval.status = "uncertain";
              } else approval.status = (body as { status: string }).status;
              return {};
            }
            return {};
          }
          await beforeRead(++calls);
          if (inbox.session.status === "stopped")
            throw new Error("Owner stopped this link");
          return {
            ...structuredClone(inbox),
            approvals: structuredClone(approvals),
          };
        }) as ChatRequest,
    },
  );
  await runner.prepare();
  const control = new LocalControl(
    join(root, "control"),
    {
      describe: () => runner.describe(),
      handle: (method, request) => runner.handle(method, request),
    },
    "fixture-pi",
  );
  await control.start();
  runner.setControl(join(root, "control", `${control.instanceId}.json`));
  return {
    root,
    file,
    bytes,
    profile,
    inbox,
    runner,
    approvals,
    kernelCalls,
    /** Once the native has said where its extension answers, and a moment for the rest. */
    settled: async () => {
      if (options.extensionControl)
        for (
          let n = 0;
          n < 200 && !(await Bun.file(join(root, "linked")).exists());
          n++
        )
          await Bun.sleep(50);
      await Bun.sleep(150);
    },
    /** What the native extension answers about the turn: `null` to refuse. */
    turn: (value: Record<string, unknown> | null) =>
      value === null
        ? rm(join(root, "turn"), { force: true })
        : writeFile(join(root, "turn"), JSON.stringify(value)),
    /** pi asks its user something. */
    ask: (request: Record<string, unknown>) =>
      appendFile(join(root, "ask"), JSON.stringify(request) + "\n"),
    answers: () =>
      readFile(join(root, "answers"), "utf8")
        .then((text) =>
          text
            .trim()
            .split("\n")
            .map((l) => JSON.parse(l)),
        )
        .catch(() => [] as Record<string, unknown>[]),
    beforeRead(fn: typeof beforeRead) {
      beforeRead = fn;
    },
    bind: (token = "fixture") => {
      validToken = token;
      return runner.handle("bind", {
        base_url: "http://127.0.0.1:4310",
        token,
      });
    },
    /** How long the native extension takes to say whose turn it is. */
    slowTurn: (ms: number) => writeFile(join(root, "turn-delay"), String(ms)),
    async close() {
      await runner.stop();
      await control.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

test("a failed creation can release only a host which never started native execution", async () => {
  const f = await fixture("create");
  try {
    expect(await f.runner.handle("discard_unstarted", {})).toEqual({
      released: true,
    });
    expect(f.runner.describe().phase).toBe("ended");
    expect(await Bun.file(join(f.root, "starts")).exists()).toBe(false);
  } finally {
    await f.close();
  }
});

test("creation records native defaults without selectors or an initial prompt", async () => {
  const f = await fixture("create");
  try {
    await f.bind();
    expect(f.runner.describe().model).toEqual({
      provider: "fixture",
      id: "native-model",
    });
    const profile = JSON.parse(await readFile(f.profile, "utf8"));
    expect(profile.initialState).toBeUndefined();
    expect(profile.unavailable).toBeUndefined();
    expect((await readFile(f.file, "utf8")).startsWith(f.bytes)).toBe(true);
    expect(await readFile(join(f.root, "commands"), "utf8")).toBe(
      "get_state\n",
    );
    await f.runner.stop();
    const { readSavedPi } = await import("./saved-session.ts");
    expect(
      (await readSavedPi(f.file, f.inbox.session.native_session_id, f.root))
        .model,
    ).toEqual({ provider: "fixture", id: "native-model" });
  } finally {
    await f.close();
  }
});

test("creation cannot mask missing native model history with sidecar defaults", async () => {
  const f = await fixture("create-unflushed");
  try {
    await expect(f.bind()).rejects.toThrow("saved pi model is missing");
    expect(JSON.parse(await readFile(f.profile, "utf8")).unavailable).toContain(
      "not confirmed",
    );
    expect(await readFile(f.file, "utf8")).toBe(f.bytes);
  } finally {
    await f.close();
  }
});

test("an RPC state response without the native extension guard cannot start a chat", async () => {
  const f = await fixture("unguarded");
  try {
    await expect(f.bind()).rejects.toThrow("did not confirm");
    expect(JSON.parse(await readFile(f.profile, "utf8")).unavailable).toContain(
      "not confirmed",
    );
  } finally {
    await f.close();
  }
});

test("native startup is gated, prompt-free and keeps the exact saved identity/profile/history", async () => {
  const f = await fixture();
  try {
    const result = await f.bind();
    const pid = result.native_pid as number;
    expect(processExists(pid)).toBe(true);
    expect(f.runner.describe().phase).toBe("running");
    expect(await f.runner.handle("discard_unstarted", {})).toEqual({
      released: false,
    });
    expect(await readFile(join(f.root, "starts"), "utf8")).toBe(`${pid}\n`);
    expect(await readFile(join(f.root, "commands"), "utf8")).toBe(
      "get_state\n",
    );
    expect(await readFile(f.file, "utf8")).toBe(f.bytes);
    // Rebinding the controller does not start another native process or input.
    f.inbox.session.id = "next-link";
    expect((await f.bind()).native_pid).toBe(pid);
    expect(await readFile(join(f.root, "starts"), "utf8")).toBe(`${pid}\n`);
    await f.runner.handle("stop", { link_id: "next-link" });
    expect(processExists(pid)).toBe(false);
  } finally {
    await f.close();
  }
}, 15_000);

test("observable owner Stop during final intent validation prevents native exec", async () => {
  const f = await fixture();
  let entered!: () => void, release!: () => void;
  const blocked = new Promise<void>((resolve) => (entered = resolve));
  const resume = new Promise<void>((resolve) => (release = resolve));
  f.beforeRead(async (call) => {
    if (call === 2) {
      entered();
      await resume;
    }
  });
  try {
    const bind = f.bind();
    const outcome = bind.catch((error: Error) => error);
    await blocked;
    f.inbox.session.status = "stopped";
    release();
    expect(((await outcome) as Error).message).toContain("Owner stopped");
    expect(await readFile(join(f.root, "starts"), "utf8").catch(() => "")).toBe(
      "",
    );
    expect(
      await readFile(join(f.root, "commands"), "utf8").catch(() => ""),
    ).toBe("");
    expect(await readFile(f.file, "utf8")).toBe(f.bytes);
    expect(f.runner.describe().phase).toBe("ended");
  } finally {
    release();
    await f.close();
  }
}, 15_000);

test("wrong native profile is refused durably, without accepting input or substituting defaults", async () => {
  const f = await fixture("model");
  try {
    await expect(f.bind()).rejects.toThrow("saved identity and profile");
    expect(JSON.parse(await readFile(f.profile, "utf8")).unavailable).toContain(
      "not confirmed",
    );
    expect(await readFile(join(f.root, "commands"), "utf8")).toBe(
      "get_state\n",
    );
    expect(await readFile(f.file, "utf8")).toBe(f.bytes);
    expect(f.runner.describe().phase).toBe("ended");
  } finally {
    await f.close();
  }
}, 15_000);

test("failure to persist the startup marker prevents native exec entirely", async () => {
  const f = await fixture("persistence");
  try {
    await expect(f.bind()).rejects.toThrow("profile storage is unavailable");
    expect(await readFile(join(f.root, "starts"), "utf8").catch(() => "")).toBe(
      "",
    );
    expect(await readFile(f.file, "utf8")).toBe(f.bytes);
    expect(f.runner.describe().phase).toBe("ended");
    const lease = await PiExecutionLease.acquire(f.runner.config);
    lease.close("exited");
  } finally {
    await f.close();
  }
}, 15_000);

test("Stop interrupts a startup awaiting native acknowledgement, without another execution", async () => {
  const f = await fixture("silent");
  try {
    const bind = f.bind();
    const outcome = bind.catch((error: Error) => error);
    for (let i = 0; i < 200; i++) {
      if (await readFile(join(f.root, "commands"), "utf8").catch(() => ""))
        break;
      await Bun.sleep(10);
    }
    await f.runner.handle("stop", { link_id: "link" });
    expect(((await outcome) as Error).message).toContain("without confirming");
    expect(
      (await readFile(join(f.root, "starts"), "utf8")).trim().split("\n"),
    ).toHaveLength(1);
    expect(await readFile(f.file, "utf8")).toBe(f.bytes);
  } finally {
    await f.close();
  }
}, 15_000);

test("a host shared by two workspaces ends only when the last link stops", async () => {
  const f = await fixture();
  try {
    const pid = (await f.bind()).native_pid as number;
    // The native extension reports the links of both workspaces, A (the binder) and B.
    const report = (ids: string[]) =>
      f.runner.handle("links", { native_pid: pid, link_ids: ids });
    await expect(
      f.runner.handle("links", { native_pid: pid + 1, link_ids: ["link"] }),
    ).rejects.toThrow("Invalid native pi link report");
    await report(["link", "link-b"]);
    // A Stop of either link alone is not a Stop of the shared pi: the extension ends
    // that link only, and the host refuses to end the process for it.
    for (const id of ["link", "link-b", "unknown"])
      await expect(f.runner.handle("stop", { link_id: id })).rejects.toThrow(
        "Unknown pi runner link",
      );
    expect(processExists(pid)).toBe(true);
    expect(f.runner.describe().phase).toBe("running");
    // B's link ended on the extension's side; A is the last one. Only A's ID ends the host.
    await report(["link"]);
    await expect(
      f.runner.handle("stop", { link_id: "link-b" }),
    ).rejects.toThrow("Unknown pi runner link");
    expect(processExists(pid)).toBe(true);
    await f.runner.handle("stop", { link_id: "link" });
    expect(processExists(pid)).toBe(false);
    expect(f.runner.describe().phase).toBe("ended");
    // Native input was never touched by any of this: one get_state, nothing else.
    expect(await readFile(join(f.root, "commands"), "utf8")).toBe(
      "get_state\n",
    );
  } finally {
    await f.close();
  }
}, 15_000);

const until = async (check: () => Promise<boolean> | boolean, ms = 5000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check()) return;
    await Bun.sleep(50);
  }
  throw new Error("condition not met in time");
};

test("pi's yes/no question in one chat's turn reaches the owner as that delivery's approval and comes back as pi's answer", async () => {
  const f = await fixture("", { extensionControl: true });
  try {
    await f.bind();
    // The turn took a ZeroLux envelope; the native extension, asked at question time,
    // names its delivery and the very message that carried it.
    const carrier = {
      role: "custom",
      customType: "zerolux-chat-delivery",
      content: "[envelope]",
      timestamp: 1733234401000,
    };
    await f.ask({ type: "agent_start" });
    await f.ask({ type: "message_start", message: carrier });
    await f.turn({
      ok: true,
      delivery: "turn-delivery",
      link_id: "link",
      fingerprint: nativeFingerprint(carrier),
    });
    await f.settled();
    await f.ask({
      type: "extension_ui_request",
      id: "q1",
      method: "confirm",
      title: "Delete?",
      message: "Remove build output",
    });
    await until(() => f.approvals.length === 1);
    expect(f.approvals[0]).toMatchObject({
      delivery_id: "turn-delivery",
      native_request_id: "pi-ui:q1",
      status: "pending",
      details: {
        method: "confirm",
        title: "Delete?",
        message: "Remove build output",
      },
    });
    expect(await f.answers()).toEqual([]);
    // The owner decides; the host dispatches, answers pi once, resolves.
    f.approvals[0]!.status = "decided";
    f.approvals[0]!.decision = "allow";
    await until(async () => (await f.answers()).length === 1);
    expect(await f.answers()).toEqual([
      { type: "extension_ui_response", id: "q1", confirmed: true },
    ]);
    await until(() => f.approvals[0]!.status === "resolved");
    expect(f.kernelCalls.map((c) => c.path)).toEqual([
      "/chat/approvals",
      "/chat/approvals/" + f.approvals[0]!.id + "/dispatch",
      "/chat/approvals/" + f.approvals[0]!.id + "/receipt",
    ]);
    // Deny answers no.
    await f.ask({
      type: "extension_ui_request",
      id: "q2",
      method: "confirm",
      title: "Again?",
    });
    await until(() => f.approvals.length === 2);
    f.approvals[1]!.status = "decided";
    f.approvals[1]!.decision = "deny";
    (f.approvals[1] as { reason?: string }).reason = "Keep the build output";
    await until(async () => (await f.answers()).length === 2);
    expect((await f.answers())[1]).toEqual({
      type: "extension_ui_response",
      id: "q2",
      confirmed: false,
    });
    // One get_state, then the answers, and the owner's reason for the denial as a steer.
    await until(async () =>
      (await readFile(join(f.root, "commands"), "utf8")).endsWith("steer\n"),
    );
    expect(await readFile(join(f.root, "commands"), "utf8")).toBe(
      "get_state\nextension_ui_response\nextension_ui_response\nsteer\n",
    );
  } finally {
    await f.close();
  }
}, 20_000);

test("a dialog outside one chat's turn still asks the owner, for the session; an unknown kind is reported", async () => {
  const f = await fixture("", { extensionControl: true });
  try {
    await f.bind();
    const attention = () =>
      f.kernelCalls.filter((c) => c.path === "/chat/sessions/link/status")
        .length;
    const carrier = {
      role: "custom",
      customType: "zerolux-chat-delivery",
      content: "[envelope]",
      timestamp: 1733234401000,
    };
    const proof = {
      ok: true,
      delivery: "turn-delivery",
      link_id: "link",
      fingerprint: nativeFingerprint(carrier),
    };
    await f.ask({ type: "agent_start" });
    await f.ask({ type: "message_start", message: carrier });
    await f.settled();
    // Private or mixed turn: the extension says no delivery.
    await f.turn({ ok: true, delivery: null, link_id: "link" });
    await f.ask({
      type: "extension_ui_request",
      id: "p1",
      method: "confirm",
      title: "?",
    });
    await until(() => f.approvals.length === 1);
    // Another workspace's link owns the turn: no chat delivery of this kernel.
    await f.turn({ ok: true, delivery: "other-delivery", link_id: "link-b" });
    await f.ask({
      type: "extension_ui_request",
      id: "p2",
      method: "confirm",
      title: "?",
    });
    await until(() => f.approvals.length === 2);
    // The extension cannot say: no chat delivery.
    await f.turn(null);
    await f.ask({
      type: "extension_ui_request",
      id: "p3",
      method: "confirm",
      title: "?",
    });
    await until(() => f.approvals.length === 3);
    // A choice in the chat's own turn: a question of that delivery.
    await f.turn(proof);
    await f.ask({
      type: "extension_ui_request",
      id: "p4",
      method: "select",
      title: "Pick",
      options: ["a", "b"],
    });
    await until(() => f.approvals.length === 4);
    expect(f.approvals[3]).toMatchObject({
      kind: "question",
      delivery_id: "turn-delivery",
      details: {
        questions: [{ id: "pi", question: "Pick", other: false }],
      },
    });
    // A dialog ZeroLux does not know: reported, never answered for the owner.
    await f.ask({
      type: "extension_ui_request",
      id: "u1",
      method: "pickFile",
      title: "File",
    });
    await until(() => attention() === 1);
    expect(f.kernelCalls.at(-1)!.body).toMatchObject({ status: "attention" });
    // A proof about an earlier input than the one the host saw the turn take last: stale.
    await f.ask({
      type: "message_start",
      message: {
        role: "user",
        content: "typed in pi",
        timestamp: 1733234402000,
      },
    });
    await f.settled();
    await f.ask({
      type: "extension_ui_request",
      id: "p5",
      method: "confirm",
      title: "?",
    });
    await until(() => f.approvals.length === 5);
    // A proof without fingerprint, or a turn whose inputs the host never saw: nothing.
    await f.ask({ type: "agent_settled" });
    await f.settled();
    await f.turn({ ok: true, delivery: "turn-delivery", link_id: "link" });
    await f.ask({
      type: "extension_ui_request",
      id: "p6",
      method: "confirm",
      title: "?",
    });
    await until(() => f.approvals.length === 6);
    await f.turn(proof);
    await f.ask({
      type: "extension_ui_request",
      id: "p7",
      method: "confirm",
      title: "?",
    });
    await until(() => f.approvals.length === 7);
    // Fire-and-forget methods are ignored.
    await f.ask({
      type: "extension_ui_request",
      id: "n1",
      method: "notify",
      message: "hi",
    });
    await Bun.sleep(300);
    // Only the choice was asked in a turn one chat of this kernel fed.
    expect(f.approvals.map((a) => a.delivery_id ?? null)).toEqual([
      null,
      null,
      null,
      "turn-delivery",
      null,
      null,
      null,
    ]);
    expect(await f.answers()).toEqual([]);
    expect(attention()).toBe(1);
  } finally {
    await f.close();
  }
}, 20_000);

test("without an extension control report a confirmation asks the owner for the session; a Stop withdraws a pending question", async () => {
  const f = await fixture();
  try {
    await f.bind();
    await f.ask({
      type: "extension_ui_request",
      id: "q1",
      method: "confirm",
      title: "?",
    });
    await until(() => f.approvals.length === 1);
    expect(f.approvals[0]!.delivery_id ?? null).toBeNull();
  } finally {
    await f.close();
  }
  const g = await fixture("", { extensionControl: true });
  try {
    await g.bind();
    const carrier = {
      role: "custom",
      customType: "zerolux-chat-delivery",
      content: "[envelope]",
      timestamp: 1733234401000,
    };
    await g.ask({ type: "agent_start" });
    await g.ask({ type: "message_start", message: carrier });
    await g.turn({
      ok: true,
      delivery: "turn-delivery",
      link_id: "link",
      fingerprint: nativeFingerprint(carrier),
    });
    await f.settled();
    await g.ask({
      type: "extension_ui_request",
      id: "q1",
      method: "confirm",
      title: "?",
    });
    await until(() => g.approvals.length === 1);
    await g.runner.handle("stop", { link_id: "link" });
    // pi was told the question is withdrawn before its input closed, and the approval resolved.
    expect(await g.answers()).toEqual([
      { type: "extension_ui_response", id: "q1", cancelled: true },
    ]);
    await until(() => g.approvals[0]!.status === "resolved");
  } finally {
    await g.close();
  }
}, 20_000);

test("a question names the chat delivery only for the input pi was on when it asked; a Stop or pi's own timeout ends it; a rebind keeps the decision path", async () => {
  const f = await fixture("", { extensionControl: true });
  try {
    await f.bind();
    const carrier = {
      role: "custom",
      customType: "zerolux-chat-delivery",
      content: "[envelope]",
      timestamp: 1733234401000,
    };
    const proof = {
      ok: true,
      delivery: "turn-delivery",
      link_id: "link",
      fingerprint: nativeFingerprint(carrier),
    };
    const attention = () =>
      f.kernelCalls.filter((c) => c.path === "/chat/sessions/link/status")
        .length;
    await f.ask({ type: "agent_start" });
    await f.ask({ type: "message_start", message: carrier });
    await f.turn(proof);
    await f.settled();
    // While the extension is still answering, the turn takes another input: the proof,
    // though matching what pi was on when it asked, is for a question of a turn that moved.
    await f.slowTurn(600);
    await f.ask({
      type: "extension_ui_request",
      id: "s1",
      method: "confirm",
      title: "?",
    });
    await Bun.sleep(200);
    await f.ask({
      type: "message_start",
      message: {
        role: "user",
        content: "typed meanwhile",
        timestamp: 1733234402000,
      },
    });
    await until(() => f.approvals.length === 1);
    expect(f.approvals[0]!.delivery_id ?? null).toBeNull();
    expect(attention()).toBe(0);
    // Back on the envelope's input: a question with pi's own timeout is routed, and when
    // that timeout passes the approval closes; a decision after it is never replayed.
    await f.slowTurn(0);
    await f.ask({ type: "agent_start" });
    await f.ask({ type: "message_start", message: carrier });
    await f.settled();
    await f.ask({
      type: "extension_ui_request",
      id: "t1",
      method: "confirm",
      title: "?",
      timeout: 700,
    });
    await until(() => f.approvals.length === 2);
    expect(f.approvals[1]!.delivery_id).toBe("turn-delivery");
    await until(() => f.approvals[1]!.status === "resolved", 3000);
    f.approvals[1]!.status = "decided";
    f.approvals[1]!.decision = "allow";
    await Bun.sleep(1200);
    expect(await f.answers()).toEqual([]);
    expect(f.kernelCalls.some((c) => c.path.endsWith("/dispatch"))).toBe(false);
    // A relink issues another session: the kernel closed the old one's approvals with
    // it, and this host withdraws the question from pi. A decision on the old approval
    // never reaches pi; nothing is asked again on the owner's behalf.
    await f.ask({
      type: "extension_ui_request",
      id: "r1",
      method: "confirm",
      title: "?",
    });
    await until(() => f.approvals.length === 3);
    f.inbox.session.id = "next-link";
    await f.bind("fixture-2");
    const about = async (id: string) =>
      (await f.answers()).filter((a) => a.id === id);
    await until(async () => (await about("r1")).length === 1);
    // The earlier session question (s1), still open in pi, is withdrawn with it.
    expect(await about("s1")).toEqual([
      { type: "extension_ui_response", id: "s1", cancelled: true },
    ]);
    expect(await about("r1")).toEqual([
      { type: "extension_ui_response", id: "r1", cancelled: true },
    ]);
    f.approvals[2]!.status = "decided";
    f.approvals[2]!.decision = "deny";
    await Bun.sleep(1200);
    expect(await about("r1")).toHaveLength(1);
    expect(f.kernelCalls.some((c) => c.path.endsWith("/dispatch"))).toBe(false);
    // The same link bound again (a kernel restart that kept the session) changes nothing:
    // the question stays, the decision arrives through the new token.
    await f.turn({ ...proof, link_id: "next-link" });
    await f.ask({
      type: "extension_ui_request",
      id: "r2",
      method: "confirm",
      title: "?",
    });
    await until(() => f.approvals.length === 4);
    await f.bind("fixture-3");
    f.approvals[3]!.status = "decided";
    f.approvals[3]!.decision = "deny";
    await until(async () => (await about("r2")).length === 1);
    expect(await about("r2")).toEqual([
      { type: "extension_ui_response", id: "r2", confirmed: false },
    ]);
    await until(() => f.approvals[3]!.status === "resolved");
    // A Stop while the extension is still answering withdraws the question at once.
    await f.slowTurn(2000);
    await f.ask({
      type: "extension_ui_request",
      id: "x1",
      method: "confirm",
      title: "?",
    });
    await Bun.sleep(200);
    // The extension's link report names the chat link it holds; Stop comes by that ID.
    await f.runner.handle("stop", { link_id: "link" });
    expect((await f.answers()).at(-1)).toEqual({
      type: "extension_ui_response",
      id: "x1",
      cancelled: true,
    });
    expect(f.approvals).toHaveLength(4);
  } finally {
    await f.close();
  }
}, 30_000);

test("pi's choices and text reach the owner as questions, and the answer comes back as pi's value", async () => {
  const f = await fixture("", { extensionControl: true });
  try {
    await f.bind();
    const cases = [
      { id: "s1", method: "select", title: "Pick", options: ["a", "b"] },
      { id: "i1", method: "input", title: "Name", placeholder: "name" },
      { id: "e1", method: "editor", title: "Notes", prefill: "draft" },
    ];
    for (const [i, request] of cases.entries()) {
      await f.ask({ type: "extension_ui_request", ...request });
      await until(() => f.approvals.length === i + 1);
    }
    expect(f.approvals.map((a) => (a.details as any).questions[0])).toEqual([
      {
        id: "pi",
        question: "Pick",
        options: [{ label: "a" }, { label: "b" }],
        multiple: false,
        other: false,
      },
      {
        id: "pi",
        question: "Name",
        options: [],
        multiple: false,
        other: true,
        placeholder: "name",
      },
      {
        id: "pi",
        question: "Notes",
        options: [],
        multiple: false,
        other: true,
        multiline: true,
        default: "draft",
      },
    ]);
    const answers = [["b"], ["Ada"], null];
    for (const [i, value] of answers.entries()) {
      f.approvals[i]!.status = "decided";
      f.approvals[i]!.answer = value
        ? { answers: { pi: value } }
        : { declined: true };
    }
    await until(async () => (await f.answers()).length === 3, 8000);
    const byId = Object.fromEntries((await f.answers()).map((a) => [a.id, a]));
    expect(byId).toEqual({
      s1: { type: "extension_ui_response", id: "s1", value: "b" },
      i1: { type: "extension_ui_response", id: "i1", value: "Ada" },
      e1: { type: "extension_ui_response", id: "e1", cancelled: true },
    });
  } finally {
    await f.close();
  }
}, 20_000);
