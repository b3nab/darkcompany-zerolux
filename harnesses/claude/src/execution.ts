import { spawn, type ChildProcess } from "node:child_process";
import { isAbsolute } from "node:path";
import type {
  SpawnOptions,
  SpawnedProcess,
} from "@anthropic-ai/claude-agent-sdk";

/** The Claude Code process this host runs for its session, started as the SDK asks. */
export class ClaudeExecution {
  private nativePid: number | null = null;
  private child?: ChildProcess;
  private phase: "waiting" | "running" | "exited" = "waiting";
  private stopped = false;
  private exited?: Promise<void>;

  describe() {
    return { native_pid: this.nativePid, native_phase: this.phase };
  }

  /** A Stop asked while the session is still binding: nothing is started after it. */
  requestStop() {
    this.stopped = true;
  }

  /** The SDK's own spawn hook: it keeps the process's input, output and life. */
  spawn(options: SpawnOptions): SpawnedProcess {
    if (this.stopped || options.signal.aborted)
      throw new Error("The session was stopped before Claude Code started");
    const executable = isAbsolute(options.command)
      ? options.command
      : Bun.which(options.command, {
          PATH: options.env.PATH,
          cwd: options.cwd,
        });
    if (!executable) throw new Error("Claude Code is not installed");
    const child = spawn(executable, options.args, {
      cwd: options.cwd,
      env: options.env,
      signal: options.signal,
      stdio: ["pipe", "pipe", "ignore"],
    });
    this.child = child;
    this.nativePid = child.pid ?? null;
    this.phase = "running";
    this.exited = new Promise<void>((resolve) => {
      const ended = () => {
        if (this.child === child) {
          this.child = undefined;
          this.phase = "exited";
        }
        resolve();
      };
      child.once("exit", ended);
      child.on("error", () => {
        if (child.pid === undefined) ended();
      });
    });
    return child;
  }

  /** On Stop, close the child we actually spawned even if it ignores EOF. */
  async waitForExit() {
    if (this.stopped) this.child?.kill();
    await this.exited;
  }
}
