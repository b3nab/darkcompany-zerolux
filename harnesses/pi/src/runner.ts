import { mkdir, realpath } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  type ChatRequest,
  type Inbox,
  LocalControl,
  chatRequest,
  controlRequest,
  localURL,
  nativeFingerprint,
  readControlDescriptor,
  settingsPatch,
  type NativeSettingsPatch,
} from "@zerolux/bridge";
import { chatExtension, forkPiSession, newPiSession } from "./new-session.ts";

export interface PiRunnerConfig {
  nativeSessionId: string;
  workspace: string;
  /** pi's own file of the session. */
  file: string;
  /** The person's pi folder, when it is not pi's default. */
  agentDir?: string;
  /**
   * The native options its terminal started it with, to start it with again. Without them
   * it is a session of ZeroLux's own, started with ZeroLux's extension.
   */
  args?: string[];
  pi: string;
  entry: string;
  /** A new session: started with the settings asked for it, if any. */
  creation?: boolean;
  initial?: NativeSettingsPatch;
}
export interface PiRunnerDeps {
  connect(base: string, token: string): ChatRequest;
  environment(): NodeJS.ProcessEnv;
}
const defaults: PiRunnerDeps = {
  connect: chatRequest,
  environment: () => process.env,
};

type Child = Bun.Subprocess<"pipe", "pipe", "pipe">;
/** What pi says it runs with, once it has started. */
interface PiState {
  model?: { provider: string; id: string };
  thinking?: string;
}

/** pi did not start: why, as the last thing it wrote says. */
const runtimeUnavailable = (said?: string) =>
  Object.assign(
    new Error(said ? `pi could not start: ${said}` : "pi is not installed"),
    { code: "pi_runtime_unavailable" },
  );

/** The command that starts pi: a command file, as npm installs on Windows, through its interpreter. */
function nativeCommand(exec: string, args: string[]) {
  if (process.platform !== "win32" || !/\.(cmd|bat)$/i.test(exec))
    return [exec, ...args];
  // As in the original command-file launcher: quotes delimit each argument, and
  // cmd.exe must not interpret an embedded quote, expansion or extra command line.
  const parts = [exec, ...args];
  if (parts.some((part) => /["%\r\n]/.test(part)))
    throw new Error(
      "This argument cannot be passed through a Windows command file",
    );
  const line = parts.map((part) => `"${part}"`).join(" ");
  const shell =
    process.env.ComSpec ??
    join(
      process.env.SystemRoot ?? process.env.windir ?? "C:\\Windows",
      "System32",
      "cmd.exe",
    );
  return [shell, "/d", "/v:off", "/s", "/c", `"${line}"`];
}

/** Detached host for ONE stock native pi RPC process. No prompts, no automatic replay/retry. */
/**
 * A pi dialog as ZeroLux asks the owner: `confirm` is a permission; `select`, `input` and
 * `editor` are one question, answered with the text pi expects as its `value`.
 */
function piRequest(event: Record<string, any>) {
  const title = typeof event.title === "string" ? event.title : "";
  const text = (key: string) =>
    typeof event[key] === "string" ? (event[key] as string) : null;
  const question = (fields: Record<string, unknown>) => ({
    kind: "question",
    summary: title || "pi asks you",
    details: {
      method: event.method,
      questions: [
        {
          id: "pi",
          question: title || "pi asks you",
          options: [],
          multiple: false,
          other: true,
          ...fields,
        },
      ],
    },
  });
  switch (event.method) {
    case "confirm":
      return {
        kind: "permission",
        summary: "pi asks for your confirmation",
        details: { method: "confirm", title, message: text("message") ?? "" },
      };
    case "select":
      return question({
        options: (Array.isArray(event.options) ? event.options : [])
          .filter((o: unknown) => typeof o === "string")
          .map((label: string) => ({ label })),
        other: false,
      });
    case "input":
      return question({ placeholder: text("placeholder") });
    case "editor":
      return question({ multiline: true, default: text("prefill") });
    default:
      return null;
  }
}

export class PiRunner {
  private readonly initial: NativeSettingsPatch;
  private state: PiState = {};
  private lastError = "";
  private child?: Child;
  // A command-file launcher is a different process from pi on Windows. Only the child
  // handle is ever signalled; the reported PID identifies pi for discovery.
  private reportedPid?: number;
  private inputClosed = false;
  private controlPath?: string;
  private identity?: { actor: string | null; company: string; link: string };
  private phase: "waiting" | "starting" | "running" | "stopping" | "ended" =
    "waiting";
  /** The links the native extension holds: a pi may serve several workspaces. */
  private links = new Set<string>();
  /** The kernel of the link that bound this host: where its native questions go. */
  private kernel?: ChatRequest;
  /** The native extension's own control, where this host asks whose turn it is. */
  private extensionControl?: string;
  /** Questions pi is waiting on, by ID: withdrawn before its input closes on a Stop. */
  private pendingDialogs = new Map<string, () => void>();
  /** The latest native input of the running turn, as this host saw it start on stdout. */
  private lastInput?: string;
  /** Bumped by every event that changes what the turn runs on: a proof is for one value. */
  private inputGeneration = 0;
  private operation?: Promise<Record<string, unknown>>;
  private readonly cancelled = new AbortController();
  private finish!: () => void;
  readonly finished = new Promise<void>((resolve) => (this.finish = resolve));

  constructor(
    readonly config: PiRunnerConfig,
    private readonly deps: PiRunnerDeps = defaults,
  ) {
    this.initial = settingsPatch(config.initial ?? {}, ["model", "effort"]);
  }

  setControl(path: string) {
    this.controlPath = path;
  }

  describe() {
    return {
      kind: "pi-runner",
      creating: Boolean(this.config.creation && this.phase !== "running"),
      native_session_id: this.config.nativeSessionId,
      workspace: this.config.workspace,
      session_file: this.config.file,
      phase: this.phase,
      native_pid: this.reportedPid ?? this.child?.pid,
      model: this.state.model,
      thinking: this.state.thinking,
      link_id: this.identity?.link,
      // This host routes pi's `confirm` dialogs to the owner as approvals.
      dialogs: 1,
    };
  }

  handle(
    method: string,
    request: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    if (method === "discard_unstarted") {
      const released =
        this.phase === "waiting" && !this.operation && !this.child;
      if (released) this.end();
      return Promise.resolve({ released });
    }
    // The native extension says which links it holds, and where this host may ask it
    // whose turn it is.
    if (
      (method === "links" || method === "verify") &&
      this.phase === "starting" &&
      this.child &&
      typeof request.native_pid === "number" &&
      Number.isSafeInteger(request.native_pid) &&
      request.native_pid > 0
    )
      this.reportedPid = request.native_pid;
    if (method === "links") {
      if (Array.isArray(request.link_ids))
        this.links = new Set(
          request.link_ids.filter((id) => typeof id === "string"),
        );
      if (typeof request.control === "string" && isAbsolute(request.control))
        this.extensionControl = request.control;
      return Promise.resolve({});
    }
    // An extension of an earlier ZeroLux asks this of its host: nothing to verify.
    if (method === "verify") return Promise.resolve({});
    if (method === "stop") {
      // A pi two workspaces share ends with its last link: the extension ends the others.
      const link = request.link_id;
      if (
        this.links.size > 1 ||
        (this.child &&
          (this.links.size
            ? !this.links.has(link as string)
            : link !== this.identity?.link))
      )
        return Promise.reject(new Error("Another link still runs this pi"));
      return this.stop().then(() => ({}));
    }
    if (method !== "bind")
      return Promise.reject(new Error("Unknown pi runner operation"));
    // A bind that comes while pi starts gets the same start.
    this.operation ??= this.bind(request).finally(() => {
      this.operation = undefined;
      if (this.phase === "waiting" && !this.child) this.end();
    });
    return this.operation;
  }

  /** The session this token is for, as its kernel says: whose questions go where. */
  private async wanted(request: ChatRequest): Promise<Inbox> {
    const inbox = await request<Inbox>("/chat/inbox");
    const { session, workspace } = inbox;
    // Another link: the kernel closed the previous session's approvals with it, so the
    // questions they carried are withdrawn from pi, never answered or asked again by us.
    if (this.identity && this.identity.link !== session.id) {
      for (const withdraw of this.pendingDialogs.values()) withdraw();
      this.pendingDialogs.clear();
    }
    this.identity = {
      actor: session.actor_id,
      company: workspace?.id ?? "",
      link: session.id,
    };
    return inbox;
  }

  private async bind(
    input: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    if (typeof input.base_url !== "string" || typeof input.token !== "string")
      throw new Error("Incomplete pi runner bind");
    const request = this.deps.connect(localURL(input.base_url), input.token);
    await this.wanted(request);
    this.kernel = request;
    if (this.phase === "running")
      return { native_pid: this.reportedPid ?? this.child!.pid };
    const executable = Bun.which(this.config.pi);
    if (!executable) throw runtimeUnavailable();
    this.phase = "starting";
    try {
      const env = Object.fromEntries(
        Object.entries(this.deps.environment()).filter(
          ([key]) =>
            !key.startsWith("ZEROLUX_") &&
            (!key.startsWith("PI_") ||
              key === "PI_CODING_AGENT_SESSION_DIR" ||
              key === "PI_OFFLINE"),
        ),
      );
      if (this.config.agentDir) env.PI_CODING_AGENT_DIR = this.config.agentDir;
      if (this.controlPath) env.ZEROLUX_PI_RUNNER = this.controlPath;
      const child = Bun.spawn(
        nativeCommand(executable, [
          ...(this.config.args ?? [
            "--extension",
            await chatExtension(this.config.entry),
          ]),
          "--session",
          this.config.file,
          "--mode",
          "rpc",
          ...(this.config.creation && this.initial.model
            ? ["--model", this.initial.model]
            : []),
          ...(this.config.creation && this.initial.effort
            ? ["--thinking", this.initial.effort]
            : []),
        ]),
        {
          cwd: this.config.workspace,
          env,
          windowsVerbatimArguments:
            process.platform === "win32" && /\.(cmd|bat)$/i.test(executable),
          stdin: "pipe",
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      this.child = child;
      const diagnostics = this.errors(child).catch(() => {});
      const stateId = randomUUID();
      const ready = this.read(child, stateId, diagnostics);
      void child.exited.then(async () => {
        await ready.catch(() => {});
        await this.operation?.catch(() => {});
        this.end();
      });
      try {
        child.stdin.write(
          JSON.stringify({ id: stateId, type: "get_state" }) + "\n",
        );
        await child.stdin.flush();
      } catch (error) {
        // The launcher can exit before the first write, rather than while reading stdout.
        await this.stopNative();
        await diagnostics;
        throw runtimeUnavailable(
          this.lastError || `it ended (${child.exitCode ?? error})`,
        );
      }
      this.state = await ready;
      this.cancelled.signal.throwIfAborted();
      this.phase = "running";
      return { native_pid: this.reportedPid ?? child.pid };
    } catch (error) {
      await this.stopNative();
      throw error;
    }
  }

  /** What pi writes of its errors goes to this host's log; its last line says why it ended. */
  private async errors(child: Child) {
    const decoder = new TextDecoder();
    for await (const bytes of child.stderr) {
      const text = decoder.decode(bytes, { stream: true });
      process.stderr.write(text);
      const line = text
        .split("\n")
        .filter((line) => line.trim())
        .at(-1);
      if (line) this.lastError = line.trim();
    }
  }

  /**
   * Reads what pi writes for as long as it runs, so its output never fills up: its dialogs go
   * to the owner, and its answer to `id` says it has started and what it runs with.
   */
  private read(
    child: Child,
    id: string,
    diagnostics: Promise<void>,
  ): Promise<PiState> {
    let resolve!: (state: PiState) => void;
    let reject!: (error: Error) => void;
    const ready = new Promise<PiState>((yes, no) => {
      resolve = yes;
      reject = no;
    });
    void (async () => {
      let buffer = "";
      const decoder = new TextDecoder();
      try {
        const reader = child.stdout.getReader();
        while (true) {
          const { value: bytes, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(bytes, { stream: true });
          let end: number;
          while ((end = buffer.indexOf("\n")) >= 0) {
            const line = buffer.slice(0, end);
            buffer = buffer.slice(end + 1);
            let event: Record<string, any>;
            try {
              event = JSON.parse(line);
            } catch {
              continue;
            }
            if (event.type === "extension_ui_request") {
              void this.dialog(child, event);
              continue;
            }
            // pi reports what an extension's call failed with only here: never drop it.
            if (event.type === "extension_error") {
              console.error(
                `[zerolux] pi extension error (${String(event.event)}): ${String(event.error)}`,
              );
              continue;
            }
            // Which input the turn runs on, as this host sees it: pi's own events, no content.
            if (
              ["agent_start", "agent_end", "agent_settled"].includes(event.type)
            ) {
              this.lastInput = undefined;
              this.inputGeneration++;
            } else if (
              event.type === "message_start" &&
              ["user", "custom", "bashExecution"].includes(event.message?.role)
            ) {
              this.lastInput =
                event.message.role === "bashExecution"
                  ? undefined
                  : nativeFingerprint(event.message);
              this.inputGeneration++;
            }
            if (event.type === "response" && event.id === id) {
              if (event.success === false)
                reject(new Error(String(event.error ?? "pi did not start")));
              else
                resolve({
                  model: event.data?.model && {
                    provider: event.data.model.provider,
                    id: event.data.model.id,
                  },
                  thinking: event.data?.thinkingLevel,
                });
            }
          }
        }
        // stdout, stderr and process exit can arrive in either order.
        await Promise.all([child.exited, diagnostics]);
        reject(
          runtimeUnavailable(this.lastError || `it ended (${child.exitCode})`),
        );
      } catch (error) {
        reject(
          error instanceof Error ? error : new Error("Native pi RPC failed"),
        );
      }
    })();
    void ready.catch(() => {});
    return ready;
  }

  /**
   * The delivery of this host's link that the native turn is for, or null. `input` is what
   * this host had seen the turn take when pi asked; the extension's answer must be about
   * that very input, and nothing may have changed meanwhile: otherwise nothing is routed.
   */
  private async turnDelivery(input: {
    fingerprint: string | undefined;
    generation: number;
  }): Promise<string | null> {
    if (!this.extensionControl || !this.identity || !input.fingerprint)
      return null;
    try {
      const descriptor = await readControlDescriptor(this.extensionControl);
      const turn = await controlRequest(descriptor, "turn", {
        native_session_id: this.config.nativeSessionId,
        workspace: this.config.workspace,
      });
      return typeof turn.delivery === "string" &&
        turn.delivery &&
        turn.link_id === this.identity.link &&
        turn.fingerprint === input.fingerprint &&
        this.inputGeneration === input.generation
        ? turn.delivery
        : null;
    } catch {
      return null;
    }
  }

  /**
   * A dialog pi opens for its user, who is not at a terminal here: a confirmation, a
   * choice or text. It goes to the owner as a request of the session, and of the chat
   * delivery when one chat feeds the turn, through the kernel of the link that bound this
   * host; the answer comes back as pi's own response, once. A dialog of an unknown kind is
   * reported, never answered on the owner's behalf. A Stop withdraws the question; pi's
   * own timeout ends it, and an answer after that is not replayed.
   */
  private async dialog(child: Child, event: Record<string, any>) {
    const id = event.id;
    if (typeof id !== "string" || !id) return;
    const fire = [
      "notify",
      "setStatus",
      "setWidget",
      "setTitle",
      "set_editor_text",
    ];
    if (fire.includes(event.method)) return;
    // What the turn ran on when pi asked: a proof must be about exactly this.
    const input = {
      fingerprint: this.lastInput,
      generation: this.inputGeneration,
    };
    const deadline =
      typeof event.timeout === "number" && event.timeout > 0
        ? Date.now() + event.timeout
        : undefined;
    const respond = (body: Record<string, unknown>) => {
      if (this.inputClosed || child.exitCode !== null) return;
      child.stdin.write(
        JSON.stringify({ type: "extension_ui_response", id, ...body }) + "\n",
      );
      void child.stdin.flush();
    };
    // From here a Stop withdraws the question, whatever stage it is at.
    this.pendingDialogs.set(id, () => respond({ cancelled: true }));
    const stopped = () =>
      this.cancelled.signal.aborted || !this.pendingDialogs.has(id);
    const resolveApproval = (approval: string) =>
      this.kernel?.(`/chat/approvals/${approval}/receipt`, {
        status: "resolved",
      }).catch(() => {});
    try {
      if (!this.kernel || this.phase !== "running") return;
      const request = piRequest(event);
      if (!request) {
        await this.kernel(
          `/chat/sessions/${encodeURIComponent(this.identity!.link)}/status`,
          {
            status: "attention",
            reason: `pi asks with a dialog ZeroLux does not know (${String(event.method)}); it waits for its own timeout.`,
          },
        ).catch(() => {});
        // Unanswered on the owner's behalf; still withdrawn by a Stop until pi's own
        // timeout, if it has one, has ended it.
        if (deadline !== undefined)
          setTimeout(
            () => this.pendingDialogs.delete(id),
            Math.max(0, deadline - Date.now()),
          ).unref();
        return;
      }
      const delivery = await this.turnDelivery(input);
      if (stopped()) return;
      const approval = randomUUID();
      try {
        await this.kernel("/chat/approvals", {
          id: approval,
          delivery_id: delivery,
          native_request_id: `pi-ui:${id}`,
          ...request,
        });
      } catch {
        return; // Not recorded: pi's own timeout decides, nothing is answered for the owner.
      }
      // The decision arrives with the inbox, through whichever kernel link is bound now.
      while (!stopped() && child.exitCode === null) {
        if (deadline !== undefined && Date.now() >= deadline) {
          // pi answered itself by now: the question is over, the approval closes, and a
          // later decision is never replayed into pi.
          this.pendingDialogs.delete(id);
          await resolveApproval(approval);
          return;
        }
        await Bun.sleep(500);
        const kernel = this.kernel;
        if (!kernel) continue;
        const inbox = await kernel<{
          approvals?: {
            id: string;
            status: string;
            decision?: string | null;
            reason?: string | null;
            answer?: { answers?: Record<string, string[]> } | null;
          }[];
        }>("/chat/inbox").catch(() => undefined);
        const current = inbox?.approvals?.find((a) => a.id === approval);
        if (!current) continue;
        if (current.status === "decided") {
          if (stopped()) break;
          const dispatched = await kernel(
            `/chat/approvals/${approval}/dispatch`,
            {},
          ).then(
            () => true,
            () => false,
          );
          if (!dispatched) continue;
          // Dispatched: the decision is spent either way. Only an open question gets it.
          if (this.pendingDialogs.delete(id)) {
            const value = current.answer?.answers?.pi?.[0];
            respond(
              event.method === "confirm"
                ? { confirmed: current.decision === "allow" }
                : value === undefined
                  ? { cancelled: true }
                  : { value },
            );
            // pi's confirmation has no reason: the owner's follows as their own words.
            if (
              event.method === "confirm" &&
              current.decision === "deny" &&
              current.reason &&
              !this.inputClosed &&
              child.exitCode === null
            ) {
              child.stdin.write(
                JSON.stringify({ type: "steer", message: current.reason }) +
                  "\n",
              );
              void child.stdin.flush();
            }
          }
          await resolveApproval(approval);
          return;
        }
        if (current.status === "resolved") {
          if (this.pendingDialogs.delete(id)) respond({ cancelled: true });
          return;
        }
      }
      // Stopped (withdrawn by the Stop), or pi went away: not decided.
      this.pendingDialogs.delete(id);
      await resolveApproval(approval);
    } catch {
      this.pendingDialogs.delete(id);
    }
  }

  private end() {
    this.phase = "ended";
    this.finish();
  }

  private cancelNative() {
    this.cancelled.abort(
      new Error("The pi execution was stopped before startup completed"),
    );
    if (this.phase !== "ended") this.phase = "stopping";
    if (this.child && !this.inputClosed) {
      for (const withdraw of this.pendingDialogs.values()) withdraw();
      this.pendingDialogs.clear();
      this.inputClosed = true;
      // An already-closed stdin must not replace the launcher's own exit reason.
      if (this.child.exitCode === null) {
        try {
          void Promise.resolve(this.child.stdin.end()).catch(() => {});
        } catch {
          /* The pipe closed before end(). */
        }
      }
    }
  }

  /** pi ends when its input does; one that does not is ended. */
  private async stopNative() {
    this.cancelNative();
    const child = this.child;
    if (child && child.exitCode === null) {
      const ended = child.exited.then(() => true);
      const waited = (ms: number) =>
        Promise.race([ended, Bun.sleep(ms).then(() => false)]);
      if (!(await waited(5000))) {
        child.kill("SIGTERM");
        if (!(await waited(3000))) child.kill("SIGKILL");
        await child.exited;
      }
    }
    this.end();
  }

  async stop() {
    this.cancelNative(); // Interrupt native startup before waiting for its completion.
    await this.operation?.catch(() => {});
    await this.stopNative();
  }
}

async function main() {
  if (process.argv[2] === "fork") {
    const [file, upTo] = process.argv.slice(3);
    console.log(
      JSON.stringify(
        await forkPiSession(file!, process.cwd(), upTo || undefined),
      ),
    );
    return;
  }
  const raw = process.env.ZEROLUX_PI_CONFIG;
  if (!raw) throw new Error("Pi runner configuration is missing");
  let config = JSON.parse(raw) as PiRunnerConfig;
  const registry = process.env.ZEROLUX_PI_REGISTRY;
  if (!registry) throw new Error("Pi runner registry is missing");
  config.workspace = await realpath(config.workspace);
  config.entry = Bun.main;
  if (config.creation)
    config = await newPiSession(
      config.workspace,
      config.entry,
      config.pi,
      config.initial,
    );
  await mkdir(registry, { recursive: true, mode: 0o700 });
  const runner = new PiRunner(config);
  const control = new LocalControl(
    registry,
    {
      describe: () => runner.describe(),
      handle: (method, request) => runner.handle(method, request),
    },
    "pi-runner",
  );
  try {
    await control.start();
    runner.setControl(join(registry, `${control.instanceId}.json`));
    await runner.finished;
  } finally {
    await control.close();
    await runner.stop();
  }
}

if (import.meta.main) await main();
