// Bun-only execution-host primitive. Keep this out of the bridge's portable entrypoint:
// a terminal pi may run under Node and delegates its lease to a Bun host process.
import { dlopen, FFIType } from "bun:ffi";
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  ftruncateSync,
  openSync,
  readSync,
  writeSync,
} from "node:fs";

export interface SessionLock {
  /** Metadata left by the previous holder, read only after obtaining the lock. */
  previous: string;
  /** Replace only this locked inode's metadata, never the file itself. */
  write(content: string): void;
  release(): void;
}

/**
 * An OS lease, not a timeout or a lockfile-presence convention. The inode is never
 * removed/replaced. A free lease does not prove the previous native process died:
 * the caller must validate `previous` before starting another execution.
 */
export function acquireSessionLock(path: string): SessionLock | undefined {
  if (process.platform === "win32")
    throw new Error("Session locks are not supported on Windows yet");
  const fd = openSync(
    path,
    constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW,
    0o600,
  );
  let kept = false;
  try {
    const info = fstatSync(fd);
    if (!info.isFile() || info.nlink !== 1 || (info.mode & 0o077) !== 0)
      throw new Error(
        "The session lock must be a private, unaliased regular file",
      );
    const libc = dlopen(
      process.platform === "darwin" ? "libc.dylib" : "libc.so.6",
      { flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 } },
    );
    try {
      if (libc.symbols.flock(fd, 2 | 4) !== 0) return undefined;
    } finally {
      libc.close();
    }
    const size = fstatSync(fd).size;
    if (size > 64 * 1024)
      throw new Error("Session lease metadata is too large");
    const bytes = Buffer.alloc(size);
    let read = 0;
    while (read < size) {
      const count = readSync(fd, bytes, read, size - read, read);
      if (!count)
        throw new Error("Session lease metadata changed while locked");
      read += count;
    }
    const previous = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    let closed = false;
    kept = true;
    return {
      previous,
      write(content) {
        if (closed) throw new Error("The session lease was released");
        const next = Buffer.from(content, "utf8");
        if (next.length > 64 * 1024)
          throw new Error("Session lease metadata is too large");
        ftruncateSync(fd, 0);
        let written = 0;
        while (written < next.length) {
          const count = writeSync(
            fd,
            next,
            written,
            next.length - written,
            written,
          );
          if (!count)
            throw new Error("Session lease metadata could not be saved");
          written += count;
        }
        fsyncSync(fd);
      },
      release() {
        if (closed) return;
        closed = true;
        closeSync(fd);
      },
    };
  } finally {
    if (!kept) closeSync(fd);
  }
}

/** Existing owned-runner contract, backed by the same lease implementation. */
export function lockSession(path: string, content: string) {
  const lease = acquireSessionLock(path);
  if (!lease) return undefined;
  try {
    lease.write(content);
    return () => lease.release();
  } catch (error) {
    lease.release();
    throw error;
  }
}
