// Bun-only execution-host primitive. Keep this out of the bridge's portable entrypoint:
// a terminal pi may run under Node and delegates its lease to a Bun host process.
import { dlopen, FFIType, ptr } from "bun:ffi";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
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
  const windows = process.platform === "win32";
  // Windows has no O_NOFOLLOW: a link at the path is refused before opening it.
  if (windows) {
    try {
      if (lstatSync(path).isSymbolicLink())
        throw new Error("The session lock must be a regular file");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  const fd = openSync(
    path,
    constants.O_RDWR | constants.O_CREAT | (constants.O_NOFOLLOW ?? 0),
    0o600,
  );
  let kept = false;
  let unlock: (() => void) | undefined;
  try {
    const info = fstatSync(fd);
    // On Windows the user's profile is private by its permissions; modes do not apply.
    if (
      !info.isFile() ||
      info.nlink !== 1 ||
      (!windows && (info.mode & 0o077) !== 0)
    )
      throw new Error(
        "The session lock must be a private, unaliased regular file",
      );
    unlock = windows ? lockWindows(path) : lockUnix(fd);
    if (!unlock) return undefined;
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
        unlock?.();
        closeSync(fd);
      },
    };
  } finally {
    if (!kept) {
      unlock?.();
      closeSync(fd);
    }
  }
}

/** flock on the open file: closing it releases the lease. */
function lockUnix(fd: number) {
  const libc = dlopen(
    process.platform === "darwin" ? "libc.dylib" : "libc.so.6",
    { flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 } },
  );
  try {
    return libc.symbols.flock(fd, 2 | 4) === 0 ? () => {} : undefined;
  } finally {
    libc.close();
  }
}

let kernel32: ReturnType<typeof openKernel32> | undefined;
function openKernel32() {
  return dlopen("kernel32.dll", {
    CreateFileW: {
      args: [
        FFIType.ptr,
        FFIType.u32,
        FFIType.u32,
        FFIType.ptr,
        FFIType.u32,
        FFIType.u32,
        FFIType.ptr,
      ],
      returns: FFIType.i64,
    },
    LockFileEx: {
      args: [
        FFIType.i64,
        FFIType.u32,
        FFIType.u32,
        FFIType.u32,
        FFIType.u32,
        FFIType.ptr,
      ],
      returns: FFIType.i32,
    },
    CloseHandle: { args: [FFIType.i64], returns: FFIType.i32 },
  });
}

/**
 * On Windows, an exclusive lock on one byte far past the metadata, held by a handle of its
 * own: the kernel's whole-file lock meets it, while the metadata stays readable. Closing the
 * handle releases the lease.
 */
function lockWindows(path: string) {
  kernel32 ??= openKernel32();
  const { CreateFileW, LockFileEx, CloseHandle } = kernel32.symbols;
  const name = Buffer.from(`${path}\0`, "utf16le");
  const handle = BigInt(
    CreateFileW(
      ptr(name),
      0xc0000000, // GENERIC_READ | GENERIC_WRITE
      7, // FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE
      null,
      3, // OPEN_EXISTING
      0x80 | 0x200000, // FILE_ATTRIBUTE_NORMAL | FILE_FLAG_OPEN_REPARSE_POINT
      null,
    ),
  );
  if (handle === -1n || handle === 0n)
    throw new Error("The session lock could not be opened");
  // OVERLAPPED: the lock's offset, 0x7fffffff00000000.
  const overlapped = new Uint8Array(32);
  new DataView(overlapped.buffer).setUint32(20, 0x7fffffff, true);
  // LOCKFILE_EXCLUSIVE_LOCK | LOCKFILE_FAIL_IMMEDIATELY
  if (LockFileEx(handle, 2 | 1, 0, 1, 0, ptr(overlapped)) === 0) {
    CloseHandle(handle);
    return undefined;
  }
  return () => void CloseHandle(handle);
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
