import { mkdir, realpath } from "node:fs/promises";
import { createRequire } from "node:module";
import { basename, join } from "node:path";
import {
  getSessionInfo,
  query,
  type PermissionMode,
  type Options,
} from "@anthropic-ai/claude-agent-sdk";
import {
  AgentLinkChild,
  chatRequest,
  LocalControl,
  Transport,
  localURL,
  type ChatRequest,
  type Inbox,
} from "@zerolux/bridge";
import { ClaudeAgent, type StartQuery } from "./agent.ts";
import { acquireSessionLock } from "@zerolux/bridge/session-lock";
import { waitAndExec } from "@zerolux/bridge/exec-gate";
import { ClaudeExecution } from "./execution.ts";

const MODES: PermissionMode[] = ["default", "acceptEdits", "plan", "auto"];

export interface Subscriber {
  start(executable: string, base: string, token: string): Promise<void>;
  stop(): Promise<void>;
}
export interface RunnerDeps {
  start: StartQuery;
  subscriber(invalidate: () => void, lost: () => void): Subscriber;
  connect(base: string, token: string): ChatRequest;
  /** Whether Claude Code already has a transcript for this session in this folder. */
  saved(nativeSessionId: string, workspace: string): Promise<boolean>;
  /** The same SDK child, guarded by this host's existing exclusive lease. */
  execution?: ClaudeExecution;
}
export interface RunnerConfig {
  nativeSessionId: string;
  workspace: string;
  mode: PermissionMode;
  /** Managed SDK child; resume uses Claude's saved session and native configuration. */
  managed?: boolean;
  /** Native prompt preset for new sessions or resumed terminal conversations. */
  systemPrompt?: "claude_code";
}

/**
 * Runs one Claude Code session for as long as the session lives. The kernel binds it to a
 * chat link, rebinds it after a restart (`prepare`, `bind`), and ends it with `stop`.
 */
export class Runner {
  readonly agent: ClaudeAgent;
  private readonly transport: Transport;
  private subscriber?: Subscriber;
  private stopping?: Promise<void>;
  /**
   * The ZeroLux session the first bind named: every later bind must name it again. Its ID is
   * the link's, so the kernel can prepare or stop it even after a lost answer.
   */
  private identity?: { id: string; actor_id: string };
  /** The kernel and token in use: the same bind again changes nothing. */
  private credentials?: string;
  /** Control operations run one at a time, in the order they arrive. */
  private ops: Promise<unknown> = Promise.resolve();
  private started = false;
  private stopped = false;
  private stopRequested = false;
  private pendingBinds = 0;
  private readonly pendingStops = new Set<string>();
  private bridgeStopping?: Promise<void>;
  private nativeRun?: Promise<void>;
  private nativeClosing?: Promise<void>;
  private ended!: () => void;
  /** Settles when the session ends: by Stop, or because Claude Code exited. */
  readonly finished = new Promise<void>((resolve) => (this.ended = resolve));

  constructor(
    private readonly config: RunnerConfig,
    private readonly deps: RunnerDeps,
  ) {
    this.transport = new Transport(() => void this.stopSubscriber());
    this.agent = new ClaudeAgent(
      { nativeSessionId: config.nativeSessionId, workspace: config.workspace },
      this.transport.request,
    );
  }

  describe() {
    return {
      kind: "claude-runner",
      native_session_id: this.config.nativeSessionId,
      workspace: this.config.workspace,
      permission_mode: this.config.mode,
      title: `Claude Code — ${basename(this.config.workspace)}`,
      busy: this.agent.busy,
      // Native startup stays issued across prepare/revocation, including legacy hosts.
      started: this.started,
      bound: this.transport.bound,
      ...(this.deps.execution
        ? { native_guard: 1, ...this.deps.execution.describe() }
        : {}),
    };
  }

  /** One control operation from the kernel, already authenticated; one at a time, in order. */
  handle(method: string, request: Record<string, unknown>) {
    // A valid Stop must be visible before a blocked bind reaches query/spawn. Cleanup
    // remains serialized, but its intent does not wait behind file/network operations.
    if (method === "bind") this.pendingBinds++;
    if (
      this.config.managed &&
      method === "stop" &&
      typeof request.link_id === "string" &&
      request.link_id.length > 0 &&
      request.link_id.length <= 200
    ) {
      if (this.identity ? this.mine(request) : this.pendingBinds === 0)
        this.requestStop();
      else if (!this.identity) this.pendingStops.add(request.link_id);
    }
    const op = this.ops
      .catch(() => {})
      .then(() => this.run(method, request))
      .finally(() => {
        if (method === "bind") this.pendingBinds--;
      });
    this.ops = op;
    return op;
  }

  private requestStop() {
    this.stopRequested = true;
    this.deps.execution?.requestStop();
    // Stop closes delivery admission immediately, not after the pending bind ACK.
    this.bridgeStopping ??= this.agent.bridge.stop().catch(() => {});
    this.transport.close();
    if (this.deps.execution) void this.closeNative().catch(() => {});
  }

  private mine(request: Record<string, unknown>) {
    return this.identity
      ? request.link_id === this.identity.id
      : typeof request.link_id === "string" && request.link_id !== "";
  }

  private async run(method: string, request: Record<string, unknown>) {
    // Before a bind names the session, any link ID may only Stop it (a start that failed).
    const mine =
      this.mine(request) && (this.identity !== undefined || method === "stop");
    // A Stop whose answer was lost may come again; nothing else does after it.
    if (this.stopped) {
      if (method === "stop" && mine) return {};
      throw new Error("The session has stopped");
    }
    if (method === "bind") return this.bind(request);
    if (!mine) throw new Error("Unknown link");
    if (method === "prepare") return this.prepare();
    if (method === "stop") return this.stop();
    throw new Error("Unknown control operation");
  }

  private async bind(request: Record<string, unknown>) {
    if (this.stopRequested)
      throw new Error("The session was stopped before binding");
    const { base_url, token, executable } = request;
    if ([base_url, token, executable].some((v) => typeof v !== "string" || !v))
      throw new Error("Incomplete bind request");
    const origin = localURL(base_url as string);
    const credentials = JSON.stringify([origin, token]);
    // The same bind again (its answer was lost) changes nothing.
    if (
      this.identity &&
      this.transport.bound &&
      credentials === this.credentials
    )
      return { link_id: this.identity.id };
    if (this.identity && !this.transport.rebindable)
      throw new Error("Prepare the link before binding it again");
    const next = this.deps.connect(origin, token as string);
    const { session } = await next<Inbox>("/chat/inbox");
    if (
      session.harness !== "claude-code" ||
      session.native_session_id !== this.config.nativeSessionId ||
      session.workspace !== this.config.workspace ||
      session.status === "stopped" ||
      (this.identity &&
        (session.id !== this.identity.id ||
          session.actor_id !== this.identity.actor_id))
    )
      throw new Error("The token does not name this session");
    this.identity ??= { id: session.id, actor_id: session.actor_id };
    if (this.pendingStops.has(this.identity.id)) this.requestStop();
    this.pendingStops.clear();
    if (this.stopRequested)
      throw new Error("The session was stopped before binding");
    const subscriber = this.deps.subscriber(
      () => {
        if (!this.stopRequested) void this.agent.refresh();
      },
      () =>
        void this.agent.bridge.attention(
          "LiveKit subscriber stopped; no prompt will be retried automatically",
        ),
    );
    this.transport.bind(next);
    try {
      await this.stopping; // The old subscriber, stopped on a revocation, has ended.
      await subscriber.start(executable as string, origin, token as string);
      if (!this.started) {
        const resume = await this.deps.saved(
          this.config.nativeSessionId,
          this.config.workspace,
        );
        if (request.resume === true && !resume)
          throw new Error(
            "The saved Claude session is missing; no replacement session was started",
          );
        const options: Options = {
          permissionMode: this.config.mode,
          ...(this.config.managed && this.config.systemPrompt
            ? {
                systemPrompt: {
                  type: "preset",
                  preset: this.config.systemPrompt,
                },
              }
            : {}),
        };
        await this.agent.bridge.connect();
        if (this.stopRequested)
          throw new Error("The session was stopped before native execution");
        this.started = true;
        const execution = this.deps.execution;
        this.nativeRun = this.agent
          .run(
            this.deps.start,
            {
              ...options,
              ...(execution
                ? {
                    spawnClaudeCodeProcess: (spawn) => execution.spawn(spawn),
                  }
                : {}),
            },
            resume,
          )
          .catch((error: unknown) =>
            console.error(
              error instanceof Error
                ? error.message
                : "Claude Code session failed",
            ),
          )
          .finally(this.ended);
      } else this.agent.bridge.forgetShown(); // A rebind follows a kernel restart.
      if (this.stopRequested)
        throw new Error("The session was stopped while binding");
      await this.agent.bridge.ready();
      if (this.stopRequested)
        throw new Error("The session was stopped while binding");
    } catch (error) {
      // Half bound: nothing more with this token, and the same bind may be tried again.
      await subscriber.stop().catch(() => {});
      await this.transport.pause();
      throw error;
    }
    this.subscriber = subscriber;
    this.credentials = credentials;
    void this.agent.refresh();
    return { link_id: this.identity.id };
  }

  /** The kernel is about to rotate the token: nothing goes out with the old one after this. */
  private async prepare() {
    await this.stopSubscriber();
    await this.transport.pause();
    return {};
  }

  /** The owner's Stop: only a turn a chat message started is interrupted, then the session ends. */
  private async stop() {
    this.stopped = true;
    // A paused or revoked link has nobody to tell: fail at once rather than wait for a bind.
    if (!this.transport.bound) this.transport.close();
    await (this.bridgeStopping ?? this.agent.bridge.stop());
    this.transport.close();
    if (this.deps.execution) await this.closeNative();
    else this.agent.close();
    await this.stopSubscriber();
    // The control answers this Stop before the process ends.
    this.ended();
    return {};
  }

  /** Host shutdown/disposal is not a Store Stop. Retain the lease through actual exit. */
  closeNative(): Promise<void> {
    this.stopRequested = true;
    this.deps.execution?.requestStop();
    return (this.nativeClosing ??= (async () => {
      this.agent.close();
      await this.nativeRun;
      await this.deps.execution?.waitForExit();
    })());
  }

  /** Stops the subscriber; a new one starts only once the old one has ended. */
  private stopSubscriber() {
    const subscriber = this.subscriber;
    this.subscriber = undefined;
    const stopping = (this.stopping ?? Promise.resolve()).then(() =>
      subscriber?.stop(),
    );
    this.stopping = stopping.catch(() => {});
    return stopping;
  }
}

/**
 * Starts a runner from its environment, as the kernel launches it, and resolves with its exit
 * code once the session ends. `ready` sees the runner before the kernel can bind it.
 */
export async function launch(
  deps: RunnerDeps,
  ready?: (runner: Runner) => void,
): Promise<number> {
  const env = process.env;
  const registry = env.ZEROLUX_RUNNER_REGISTRY;
  const nativeSessionId = env.ZEROLUX_NATIVE_SESSION;
  const mode = env.ZEROLUX_PERMISSION_MODE as PermissionMode;
  if (!registry || !nativeSessionId || !env.ZEROLUX_WORKSPACE || !mode)
    throw new Error(
      "ZEROLUX_RUNNER_REGISTRY, ZEROLUX_NATIVE_SESSION, ZEROLUX_WORKSPACE and ZEROLUX_PERMISSION_MODE are required",
    );
  if (!MODES.includes(mode)) throw new Error(`Unknown permission mode ${mode}`);
  const workspace = await realpath(env.ZEROLUX_WORKSPACE);
  const managed = env.ZEROLUX_CLAUDE_MANAGED === "1";
  const systemPrompt = managed ? env.ZEROLUX_SYSTEM_PROMPT : undefined;
  if (systemPrompt !== undefined && systemPrompt !== "claude_code")
    throw new Error(`Unknown system prompt ${systemPrompt}`);
  const runnerDeps: RunnerDeps = { ...deps };
  const runner = new Runner(
    {
      nativeSessionId,
      workspace,
      mode,
      ...(managed ? { managed } : {}),
      ...(systemPrompt ? { systemPrompt: "claude_code" } : {}),
    },
    runnerDeps,
  );
  const control = new LocalControl(
    registry,
    {
      describe: () => runner.describe(),
      handle: (method, request) => runner.handle(method, request),
    },
    "claude",
  );
  await mkdir(registry, { recursive: true, mode: 0o700 });
  const lock = acquireSessionLock(join(registry, `${nativeSessionId}.lock`));
  if (!lock) {
    console.error("Another runner already holds this session");
    return 3;
  }
  // SIGTERM (the machine shutting down) ends the process cleanly; Stop is the kernel's `stop`.
  const terminated = new Promise<void>((resolve) =>
    process.once("SIGTERM", () => resolve()),
  );
  let execution: ClaudeExecution | undefined;
  try {
    if (managed) {
      execution = new ClaudeExecution(
        lock,
        {
          nativeSessionId,
          workspace,
          instanceId: control.instanceId,
        },
        import.meta.path,
      );
      runnerDeps.execution = execution;
    } else {
      // Exact legacy lease and launch behavior for kernels without this protocol.
      lock.write(
        JSON.stringify({ pid: process.pid, instance_id: control.instanceId }),
      );
    }
    ready?.(runner);
    await control.start();
    await Promise.race([runner.finished, terminated]);
  } finally {
    try {
      try {
        if (execution) await runner.closeNative();
      } finally {
        await control.close();
      }
      execution?.release(true);
    } finally {
      execution?.release(); // If cleanup failed, retain unreleased evidence.
      lock.release();
    }
  }
  return 0;
}

/**
 * The Claude Code this host runs: the installed executable the embedder named; else the
 * native CLI the SDK packages for this platform, resolved as the SDK itself does (musl
 * first on a musl Linux); else, with no SDK package installed, the `claude` on PATH. One
 * executable path for this host. None: nothing to run or restore with.
 */
export function resolveClaudeExecutable(
  named = process.env.ZEROLUX_CLAUDE_EXECUTABLE,
  platform = process.platform,
  arch = process.arch,
  musl = isMusl(),
  onPath: (name: string) => string | null = (name) => Bun.which(name),
): string {
  if (named) return named;
  const base = "@anthropic-ai/claude-agent-sdk";
  const suffix = platform === "win32" ? ".exe" : "";
  const candidates =
    platform === "linux"
      ? musl
        ? [`${base}-linux-${arch}-musl`, `${base}-linux-${arch}`]
        : [`${base}-linux-${arch}`, `${base}-linux-${arch}-musl`]
      : [`${base}-${platform}-${arch}`];
  const require = createRequire(import.meta.url);
  for (const candidate of candidates)
    try {
      return require.resolve(`${candidate}/claude${suffix}`);
    } catch {
      /* The next candidate, or none. */
    }
  const installed = onPath(`claude${suffix}`);
  if (installed) return installed;
  throw new Error(
    `No Claude Code for ${platform}-${arch}: install Claude Code (on PATH, or named with ZEROLUX_CLAUDE_EXECUTABLE), or the SDK's native package`,
  );
}

function isMusl(): boolean {
  if (process.platform !== "linux") return false;
  const report = (
    process as unknown as {
      report?: {
        getReport?: () => { header?: { glibcVersionRuntime?: string } };
      };
    }
  ).report?.getReport?.();
  return !report?.header?.glibcVersionRuntime;
}

if (import.meta.main && process.argv[2] === "exec") waitAndExec("Claude Code");
else if (import.meta.main) {
  const managed = process.env.ZEROLUX_CLAUDE_MANAGED === "1";
  // Resolve the installed executable once for this managed host.
  let pinned: string | undefined;
  const executable = () => (pinned ??= resolveClaudeExecutable());
  launch({
    start: (parameters) =>
      query({
        ...parameters,
        options: {
          ...parameters.options,
          ...(managed
            ? { pathToClaudeCodeExecutable: executable() }
            : process.env.ZEROLUX_CLAUDE_EXECUTABLE
              ? {
                  pathToClaudeCodeExecutable:
                    process.env.ZEROLUX_CLAUDE_EXECUTABLE,
                }
              : {}),
        },
      }),
    subscriber: (invalidate, lost) => new AgentLinkChild(invalidate, lost),
    connect: chatRequest,
    saved: async (id, dir) => Boolean(await getSessionInfo(id, { dir })),
  }).then(
    (code) => process.exit(code),
    (error: unknown) => {
      console.error(error instanceof Error ? error.message : "Runner failed");
      process.exit(1);
    },
  );
}
