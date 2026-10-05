import { localURL } from "@zerolux/bridge";

export interface Connection {
  id: string;
  actor_id: string;
  project_id: string;
  workspace: string;
  session_id: string | null;
}
export interface Claim {
  task: { id: string; title: string };
  run: { id: string };
  prompt: string;
}
export interface Host {
  cwd: string;
  sessionId: string;
  isIdle(): boolean;
  hasPendingMessages(): boolean;
  send(prompt: string): void;
  abort(): void;
  notify(message: string, level: "info" | "warning" | "error"): void;
  status(message?: string): void;
}
interface ActiveRun {
  claim: Claim;
  deadline: number;
  finalText: string;
  stopReason?: string;
  error?: string;
  outcome?: string;
  finishing: boolean;
}
export type Transport = <T>(
  base: string,
  path: string,
  body?: unknown,
) => Promise<T>;

export const request: Transport = async <T>(
  base: string,
  path: string,
  body?: unknown,
): Promise<T> => {
  const response = await fetch(`${base}/api${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers:
      body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(5000),
    redirect: "error",
  });
  if (!response.ok) {
    const text = await response.text();
    let detail = text;
    try {
      detail = (JSON.parse(text) as { error?: string }).error ?? text;
    } catch {
      /* framework errors can be plain text */
    }
    throw new Error(`ZeroLux ${response.status}: ${detail.slice(0, 500)}`);
  }
  return response.status === 204
    ? (undefined as T)
    : ((await response.json()) as T);
};

export function boundedText(value: string, max = 64 * 1024): string {
  const bytes = new TextEncoder().encode(value);
  if (bytes.length <= max) return value;
  const marker = "\n[output truncated]";
  // A streaming decode excludes a trailing incomplete UTF-8 sequence.
  return (
    new TextDecoder().decode(bytes.slice(0, max - marker.length), {
      stream: true,
    }) + marker
  );
}

/** One explicitly connected, existing pi session. No subprocesses, session files, or credential access. */
export class Bridge {
  private connection?: Connection;
  private active?: ActiveRun;
  private timer?: ReturnType<typeof setTimeout>;
  private closed = false;
  private taking = false;
  private connecting = false;
  private base = "";

  constructor(
    private host: Host,
    private transport: Transport = request,
    private heartbeatMs = 20_000,
    private runTimeoutMs = 30 * 60_000,
  ) {}

  get busy(): boolean {
    return !!this.active || this.taking || this.connecting;
  }
  get connected(): boolean {
    return !!this.connection && !this.closed;
  }

  async connect(
    projectId: string,
    actorId: string,
    server: string,
  ): Promise<void> {
    if (this.connection || this.connecting || this.closed)
      throw new Error("Disconnect before connecting again");
    this.base = localURL(server);
    this.connecting = true;
    try {
      const health = await this.call<{ capabilities?: string[] }>("/health");
      if (!health.capabilities?.includes("byoh-v1"))
        throw new Error(
          "This ZeroLux kernel does not support BYOH (missing byoh-v1)",
        );
      if (this.closed) throw new Error("Session closed while connecting");
      const connection = await this.call<Connection>("/connections", {
        actor_id: actorId,
        project_id: projectId,
        mode: "pi_session",
        workspace: this.host.cwd,
        session_id: this.host.sessionId,
      });
      if (this.closed) {
        await this.call(
          `/connections/${encodeURIComponent(connection.id)}/disconnect`,
          {},
        );
        throw new Error("Session closed while connecting");
      }
      this.connection = connection;
      this.host.status("ZeroLux · connected · manual take");
      this.host.notify(
        `Connected this pi session to ZeroLux. Workspace: ${connection.workspace}. No task started.`,
        "info",
      );
      this.schedule();
    } finally {
      this.connecting = false;
    }
  }

  async take(): Promise<void> {
    const connection = this.connection;
    if (!connection || this.closed) throw new Error("Connect first");
    if (this.busy || !this.host.isIdle() || this.host.hasPendingMessages())
      throw new Error("Wait for pi to be idle with no pending messages");
    this.taking = true;
    try {
      const claim = await this.call<Claim | null>("/worker/claim", {
        actor_id: connection.actor_id,
        project_id: connection.project_id,
        connection_id: connection.id,
      });
      if (!claim) {
        if (!this.closed)
          this.host.notify(
            "No queued task assigned to this agent in this project",
            "info",
          );
        return;
      }
      if (
        this.closed ||
        !this.host.isIdle() ||
        this.host.hasPendingMessages()
      ) {
        await this.finishClaim(
          claim,
          "",
          "Pi became busy or disconnected before task delivery",
        );
        throw new Error(
          "Task was not delivered; inspect and explicitly retry it in ZeroLux",
        );
      }
      this.active = {
        claim,
        deadline: Date.now() + this.runTimeoutMs,
        finalText: "",
        finishing: false,
      };
      this.host.status(`ZeroLux · running ${claim.task.id.slice(0, 8)}`);
      try {
        this.host.send(claim.prompt);
      } catch (error) {
        this.active = undefined;
        await this.finishClaim(
          claim,
          "",
          `Cannot deliver task: ${String(error)}`,
        );
        if (!this.closed) this.host.status("ZeroLux · connected · manual take");
        throw error;
      }
    } finally {
      this.taking = false;
    }
  }

  // Only new assistant messages during the owned task are observed. Never read conversation history.
  message(message: {
    role: string;
    content?: unknown;
    stopReason?: string;
    errorMessage?: string;
  }): void {
    if (!this.active || this.active.finishing || message.role !== "assistant")
      return;
    const text = Array.isArray(message.content)
      ? message.content
          .filter(
            (item): item is { type: "text"; text: string } =>
              item !== null &&
              typeof item === "object" &&
              item.type === "text" &&
              typeof item.text === "string",
          )
          .map((item) => item.text)
          .join("\n")
      : "";
    this.active.finalText = boundedText(text);
    this.active.stopReason = message.stopReason;
    this.active.error = message.errorMessage
      ? boundedText(message.errorMessage, 1800)
      : undefined;
  }

  beforeSettle(outcome: string): void {
    if (this.active) this.active.outcome = outcome;
  }

  // agent_end is NOT completion: retries, compaction and continuations may still follow.
  async settled(): Promise<void> {
    const active = this.active;
    if (!active || active.finishing || this.closed) return;
    active.finishing = true;
    const success =
      active.stopReason === "stop" &&
      active.outcome === "completed" &&
      active.finalText.trim().length > 0;
    const failure = success
      ? undefined
      : (active.error ??
        `Pi did not complete the task (${active.outcome ?? active.stopReason ?? "no final response"})`);
    try {
      await this.finishClaim(active.claim, active.finalText, failure);
      if (this.closed) return;
      this.host.notify(
        success
          ? "ZeroLux: result submitted for human review. Nothing was approved or committed."
          : `ZeroLux: run failed. ${failure}`,
        success ? "info" : "warning",
      );
    } catch (error) {
      if (this.closed) return;
      // Do not retry execution or pretend delivery succeeded. The lease makes the orphan fail.
      this.host.notify(
        `Result delivery failed: ${String(error)}. Inspect ZeroLux and the workspace before retrying.`,
        "error",
      );
      await this.disconnect("Result delivery failed");
    } finally {
      if (this.active === active) this.active = undefined;
      if (!this.closed) this.host.status("ZeroLux · connected · manual take");
    }
  }

  describe(): string {
    if (!this.connected || !this.connection) return "ZeroLux: disconnected";
    return `ZeroLux: ${this.active ? `running ${this.active.claim.task.id}` : "connected, idle"}\nProject: ${this.connection.project_id}\nActor: ${this.connection.actor_id}\nSession: ${this.host.sessionId}\nWorkspace: ${this.connection.workspace}`;
  }

  async disconnect(reason = "Pi bridge disconnected"): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.timer);
    const active = this.active;
    this.active = undefined;
    if (active && !active.finishing) {
      this.host.abort();
      try {
        await this.finishClaim(active.claim, active.finalText, reason);
      } catch {
        /* lease recovery handles unavailable kernel */
      }
    }
    if (this.connection) {
      try {
        await this.call(
          `/connections/${encodeURIComponent(this.connection.id)}/disconnect`,
          {},
        );
      } catch {
        this.host.notify(
          "ZeroLux unreachable; the connection/run will expire. Inspect partial changes before retrying.",
          "warning",
        );
      }
    }
    this.connection = undefined;
    this.host.status(undefined);
  }

  private call<T>(path: string, body?: unknown): Promise<T> {
    return this.transport<T>(this.base, path, body);
  }
  private async finishClaim(
    claim: Claim,
    stdout: string,
    failure?: string,
  ): Promise<void> {
    await this.call(`/worker/runs/${encodeURIComponent(claim.run.id)}/finish`, {
      stdout,
      stderr: "",
      exit_code: failure ? null : 0,
      failure_reason: failure ? boundedText(failure, 1900) : null,
    });
  }
  private schedule(): void {
    if (this.closed) return;
    this.timer = setTimeout(() => {
      void this.tick();
    }, this.heartbeatMs);
  }
  private async tick(): Promise<void> {
    const connection = this.connection;
    if (this.closed || !connection) return;
    const active = this.active;
    if (active && Date.now() >= active.deadline && !active.finishing) {
      this.host.notify(
        "ZeroLux run reached its 30-minute deadline; stopping this task and disconnecting",
        "warning",
      );
      await this.disconnect("Pi task timed out");
      return;
    }
    try {
      await this.call(
        active && !active.finishing
          ? `/worker/runs/${encodeURIComponent(active.claim.run.id)}/heartbeat`
          : `/connections/${encodeURIComponent(connection.id)}/heartbeat`,
        {},
      );
    } catch (error) {
      if (this.closed) return;
      // A run can finish while its heartbeat is in flight. The connection heartbeat will verify liveness next.
      if (
        active &&
        (this.active !== active || active.finishing) &&
        !this.closed
      ) {
        this.schedule();
        return;
      }
      this.host.notify(
        `ZeroLux heartbeat lost: ${String(error)}. Stopping owned work.`,
        "error",
      );
      await this.disconnect("Kernel heartbeat failed");
      return;
    }
    this.schedule();
  }
}
