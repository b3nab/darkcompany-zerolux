import { spawn } from "node:child_process";
import { isAbsolute } from "node:path";
import type {
  SpawnOptions,
  SpawnedProcess,
} from "@anthropic-ai/claude-agent-sdk";
import type { SessionLock } from "@zerolux/bridge/session-lock";
import { processExists } from "@zerolux/bridge/process-state";

interface Identity {
  nativeSessionId: string;
  workspace: string;
  instanceId: string;
}
interface Owner extends Identity {
  version: 1;
  kind: "claude-execution";
  holderPid: number;
  nativePid: number | null;
  phase: "waiting" | "starting" | "running" | "exited";
  /** Whether a managed native child has been launched for this session. */
  started: boolean;
  released: boolean;
}
const pid = (value: unknown): value is number =>
  Number.isInteger(value) &&
  (value as number) > 0 &&
  (value as number) <= 0x7fffffff;

/** One SDK-owned child, recorded under the existing host lease, not another supervisor. */
export class ClaudeExecution {
  private owner: Owner;
  private used = false;
  private closed = false;
  private stopped = false;
  private writeError?: unknown;
  private exited?: Promise<void>;

  constructor(
    private readonly lock: SessionLock,
    identity: Identity,
    private readonly entry: string,
    alive: (pid: number) => boolean = processExists,
  ) {
    if (
      !identity.nativeSessionId ||
      !identity.instanceId ||
      !isAbsolute(identity.workspace) ||
      !isAbsolute(entry)
    )
      throw new Error("Invalid Claude execution identity");
    let previous: Owner | undefined;
    if (lock.previous) {
      const record = JSON.parse(lock.previous);
      // Legacy hosts recorded only their own PID. The kernel checks native discovery
      // before launch, and Runner requires the saved native session before resume.
      if (
        record &&
        pid(record.pid) &&
        typeof record.instance_id === "string" &&
        record.instance_id &&
        Object.keys(record).every(
          (key) => key === "pid" || key === "instance_id",
        )
      ) {
        if (alive(record.pid))
          throw new Error("The previous Claude execution host is still alive");
        previous = {
          ...identity,
          instanceId: record.instance_id,
          version: 1,
          kind: "claude-execution",
          holderPid: record.pid,
          nativePid: null,
          phase: "exited",
          started: true,
          released: true,
        };
      } else previous = record as Owner;
      if (
        !previous ||
        previous.version !== 1 ||
        previous.kind !== "claude-execution" ||
        previous.nativeSessionId !== identity.nativeSessionId ||
        previous.workspace !== identity.workspace ||
        typeof previous.instanceId !== "string" ||
        !previous.instanceId ||
        !pid(previous.holderPid) ||
        (previous.nativePid !== null && !pid(previous.nativePid)) ||
        !["waiting", "starting", "running", "exited"].includes(
          previous.phase,
        ) ||
        typeof previous.started !== "boolean" ||
        typeof previous.released !== "boolean" ||
        (previous.phase === "waiting" && previous.nativePid !== null) ||
        (previous.phase === "exited" && !previous.started) ||
        (previous.phase === "running" &&
          (!previous.started || previous.nativePid === null)) ||
        (previous.phase === "starting" &&
          (!previous.started || previous.nativePid !== null)) ||
        (previous.released &&
          previous.phase !== "waiting" &&
          previous.phase !== "exited")
      )
        throw new Error(
          "The previous Claude execution cannot be identified; no replacement was started",
        );
      if (!previous.released) {
        if (previous.phase === "starting")
          throw new Error(
            "Claude startup has no confirmed child identity; no replacement was started",
          );
        if (
          previous.nativePid !== null &&
          previous.phase !== "exited" &&
          alive(previous.nativePid)
        )
          throw new Error(
            "The previous native Claude process is still alive; a free helper lease is not proof of death",
          );
        if (alive(previous.holderPid))
          throw new Error("The previous Claude execution host is still alive");
      }
    }
    this.owner = {
      ...identity,
      version: 1,
      kind: "claude-execution",
      holderPid: process.pid,
      nativePid: null,
      phase: "waiting",
      started: previous?.started ?? false,
      released: false,
    };
    this.save();
  }

  // "running" means a claimed live child (possibly still gated), NOT a native startup ACK.
  describe() {
    return { native_pid: this.owner.nativePid, native_phase: this.owner.phase };
  }

  /** Stop intent is visible even while bind/preflight is waiting in another operation. */
  requestStop() {
    this.stopped = true;
  }

  /** The SDK's public spawn hook, retaining its sole ownership of stdin and lifecycle. */
  spawn(options: SpawnOptions): SpawnedProcess {
    if (this.closed || this.stopped || options.signal.aborted)
      throw new Error("Claude startup was stopped before native execution");
    if (this.used)
      throw new Error("This Claude host cannot start another native process");
    const executable = isAbsolute(options.command)
      ? options.command
      : Bun.which(options.command, {
          PATH: options.env.PATH,
          cwd: options.cwd,
        });
    if (!executable)
      throw new Error("The Claude execution command is unavailable");
    if (options.cwd !== this.owner.workspace)
      throw new Error("The Claude execution workspace changed");
    const authorization =
      JSON.stringify({ exec: executable, args: options.args }) + "\n";
    if (Buffer.byteLength(authorization) > 64 * 1024)
      throw new Error("The Claude exec request is too large");
    this.used = true;
    this.owner.started = true;
    this.owner.phase = "starting";
    this.save();
    // Only the gate starts here. It cannot open native state until the PID is durable.
    const child = spawn(process.execPath, [this.entry, "exec"], {
      cwd: options.cwd,
      env: options.env,
      // Honor SDK disposal/error as well as Stop. Neither signal delivery nor stream
      // closure proves death; only the exit callback below does. Relink never closes SDK.
      signal: options.signal,
      stdio: ["pipe", "pipe", "ignore"],
    });
    this.exited = new Promise<void>((resolve) => {
      const ended = () => {
        if (!this.closed) {
          this.owner.phase = "exited";
          try {
            this.save();
          } catch (error) {
            this.writeError = error;
          }
        }
        resolve();
      };
      child.once("exit", ended);
      child.on("error", () => {
        // A spawn failure with no PID cannot have executed a native command.
        // Errors after a PID exists are NOT proof of exit; wait for the exit event.
        if (child.pid === undefined) ended();
      });
    });
    try {
      if (!pid(child.pid))
        throw new Error("The Claude gate has no process identity");
      this.owner.nativePid = child.pid;
      this.owner.phase = "running";
      this.save();
      if (this.stopped || options.signal.aborted)
        throw new Error("Claude startup was stopped before native execution");
      child.stdin.write(authorization);
      return child;
    } catch (error) {
      // No authorization was sent: EOF makes the gate exit without any native work.
      child.stdin.end();
      throw error;
    }
  }

  /** SDK completion/close is not this proof: only the actual child exit resolves it. */
  async waitForExit() {
    await this.exited;
    if (this.writeError) throw this.writeError;
  }

  /** Release the host lease, recording clean native exit when confirmed. */
  release(clean = false) {
    if (this.closed) return;
    if (clean) {
      if (this.owner.phase !== "waiting" && this.owner.phase !== "exited")
        throw new Error("Native Claude has not confirmed its exit");
      this.owner.released = true;
      this.save();
    }
    this.closed = true;
    this.lock.release();
  }

  private save() {
    this.lock.write(JSON.stringify(this.owner));
  }
}
