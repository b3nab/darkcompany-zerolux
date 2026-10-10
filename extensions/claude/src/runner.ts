import { mkdir, realpath } from "node:fs/promises";
import { basename, join } from "node:path";
import {
  getSessionInfo,
  query,
  type PermissionMode,
} from "@anthropic-ai/claude-agent-sdk";
import {
  AgentLinkChild,
  chatRequest,
  LocalControl,
  localURL,
  Transport,
  type ChatRequest,
  type Inbox,
} from "@zerolux/bridge";
import { ClaudeAgent, type StartQuery } from "./agent.ts";
import { lockSession } from "./lock.ts";

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
}
export interface RunnerConfig {
  nativeSessionId: string;
  workspace: string;
  mode: PermissionMode;
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
      bound: this.transport.bound,
    };
  }

  /** One control operation from the kernel, already authenticated; one at a time, in order. */
  handle(method: string, request: Record<string, unknown>) {
    const op = this.ops.catch(() => {}).then(() => this.run(method, request));
    this.ops = op;
    return op;
  }

  private async run(method: string, request: Record<string, unknown>) {
    // Before a bind names the session, any link ID may only Stop it (a start that failed).
    const mine = this.identity
      ? request.link_id === this.identity.id
      : method === "stop" &&
        typeof request.link_id === "string" &&
        request.link_id !== "";
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
    const subscriber = this.deps.subscriber(
      () => void this.agent.refresh(),
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
        await this.agent.bridge.connect();
        const resume = await this.deps.saved(
          this.config.nativeSessionId,
          this.config.workspace,
        );
        this.started = true;
        void this.agent
          .run(this.deps.start, { permissionMode: this.config.mode }, resume)
          .catch((error: unknown) =>
            console.error(
              error instanceof Error
                ? error.message
                : "Claude Code session failed",
            ),
          )
          .finally(this.ended);
      } else this.agent.bridge.forgetShown(); // A rebind follows a kernel restart.
      await this.agent.bridge.ready();
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
    await this.agent.bridge.stop();
    this.transport.close();
    this.agent.close();
    await this.stopSubscriber();
    // The control answers this Stop before the process ends.
    this.ended();
    return {};
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
  const runner = new Runner({ nativeSessionId, workspace, mode }, deps);
  ready?.(runner);
  const control = new LocalControl(
    registry,
    {
      describe: () => runner.describe(),
      handle: (method, request) => runner.handle(method, request),
    },
    "claude",
  );
  await mkdir(registry, { recursive: true, mode: 0o700 });
  const release = lockSession(
    join(registry, `${nativeSessionId}.lock`),
    JSON.stringify({ pid: process.pid, instance_id: control.instanceId }),
  );
  if (!release) {
    console.error("Another runner already holds this session");
    return 3;
  }
  // SIGTERM (the machine shutting down) ends the process cleanly; Stop is the kernel's `stop`.
  const terminated = new Promise<void>((resolve) =>
    process.once("SIGTERM", () => resolve()),
  );
  try {
    await control.start();
    await Promise.race([runner.finished, terminated]);
  } finally {
    await control.close();
    release();
  }
  return 0;
}

if (import.meta.main)
  launch({
    start: query,
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
