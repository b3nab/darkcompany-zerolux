import {
  acquireSessionLock,
  type SessionLock,
} from "@zerolux/bridge/session-lock";
import { processExists } from "@zerolux/bridge/process-state";
export { processExists };
import { lstat, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join } from "node:path";

interface Owner {
  version: 1;
  nativeSessionId: string;
  file: string;
  workspace: string;
  holderPid: number;
  nativePid: number | null;
  released: boolean;
}
export interface PiExecutionIdentity {
  nativeSessionId: string;
  file: string;
  workspace: string;
}

/** A canonical adjacent sidecar makes terminal/managed hosts use the same inode. */
export async function piLeaseFile(file: string): Promise<string> {
  if (!isAbsolute(file))
    throw new Error("Pi requires an absolute native session file");
  const parent = await realpath(dirname(file));
  const canonical = join(parent, basename(file));
  const info = await lstat(canonical).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (info && (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1))
    throw new Error("Pi history must be an unaliased regular file");
  return `${canonical}.zerolux.lock`;
}

/**
 * The holder may be a detached runner or a terminal's process-anchored helper.
 * Helper loss does NOT permit another execution: the native PID remains authoritative
 * after the OS releases the helper's flock. There is no age-based lease stealing.
 */
export class PiExecutionLease {
  private constructor(
    private readonly lock: SessionLock,
    private readonly owner: Owner,
    private readonly terminal: boolean,
    private readonly alive: (pid: number) => boolean,
    private readonly previous?: Owner,
  ) {}

  static async acquire(
    identity: PiExecutionIdentity,
    options: { terminalPid?: number; alive?: (pid: number) => boolean } = {},
  ): Promise<PiExecutionLease> {
    const path = await piLeaseFile(identity.file);
    const file = path.slice(0, -".zerolux.lock".length);
    const workspace = await realpath(identity.workspace);
    const alive = options.alive ?? processExists;
    if (
      !identity.nativeSessionId ||
      !isAbsolute(identity.workspace) ||
      (options.terminalPid !== undefined &&
        (!Number.isInteger(options.terminalPid) || options.terminalPid <= 0))
    )
      throw new Error("Invalid pi execution identity");
    const lock = acquireSessionLock(path);
    if (!lock)
      throw new Error("Another controller holds the native pi execution lease");
    try {
      let previous: Owner | undefined;
      if (lock.previous) {
        previous = JSON.parse(lock.previous) as Owner;
        if (
          previous.version !== 1 ||
          previous.nativeSessionId !== identity.nativeSessionId ||
          previous.file !== file ||
          previous.workspace !== workspace ||
          !Number.isInteger(previous.holderPid) ||
          previous.holderPid <= 0 ||
          (previous.nativePid !== null &&
            (!Number.isInteger(previous.nativePid) ||
              previous.nativePid <= 0)) ||
          typeof previous.released !== "boolean"
        )
          throw new Error(
            "The previous pi execution cannot be identified; no replacement was started",
          );
        if (!previous.released) {
          if (
            previous.nativePid !== null &&
            previous.nativePid !== options.terminalPid &&
            alive(previous.nativePid)
          )
            throw new Error(
              "The previous native pi process is still alive; its free helper lease is not proof of death",
            );
          if (previous.holderPid !== process.pid && alive(previous.holderPid))
            throw new Error("The previous pi execution host is still alive");
        }
      }
      const owner: Owner = {
        version: 1,
        nativeSessionId: identity.nativeSessionId,
        file,
        workspace,
        holderPid: process.pid,
        nativePid: options.terminalPid ?? null,
        released: false,
      };
      lock.write(JSON.stringify(owner));
      return new PiExecutionLease(
        lock,
        owner,
        options.terminalPid !== undefined,
        alive,
        previous,
      );
    } catch (error) {
      lock.release();
      throw error;
    }
  }

  get identity(): PiExecutionIdentity {
    return {
      nativeSessionId: this.owner.nativeSessionId,
      file: this.owner.file,
      workspace: this.owner.workspace,
    };
  }

  /** A completed native exit/switch is stronger evidence than a subsequently reused PID. */
  previousNativeStopped(pid: number): boolean {
    return this.previous?.released === true && this.previous.nativePid === pid;
  }

  /** Save the gated child's PID BEFORE it receives permission to exec native pi. */
  setNativeProcess(pid: number) {
    if (
      this.terminal ||
      this.owner.nativePid !== null ||
      !Number.isInteger(pid) ||
      pid <= 0
    )
      throw new Error("The pi execution already has a native process");
    this.owner.nativePid = pid;
    this.lock.write(JSON.stringify(this.owner));
  }

  /** Preserve evidence on abrupt loss; only a proven native exit marks it released. */
  close(reason: "lost" | "exited" | "switched" = "lost") {
    if (reason !== "lost") {
      if (reason === "switched" && !this.terminal)
        throw new Error(
          "Only the native terminal may confirm its session switch",
        );
      if (
        reason === "exited" &&
        this.owner.nativePid !== null &&
        this.alive(this.owner.nativePid)
      )
        throw new Error("Native pi has not confirmed its exit");
      this.owner.released = true;
      this.lock.write(JSON.stringify(this.owner));
    }
    this.lock.release();
  }
}
