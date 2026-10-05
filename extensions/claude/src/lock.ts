import { dlopen, FFIType } from "bun:ffi";
import {
  closeSync,
  constants,
  fstatSync,
  ftruncateSync,
  openSync,
  writeSync,
} from "node:fs";

const LOCK_EX = 2;
const LOCK_NB = 4;

/**
 * One runner per session: an exclusive flock, released by the system when the process ends.
 * The file is never removed. Returns the release, or nothing when another runner holds it.
 */
export function lockSession(path: string, content: string) {
  if (process.platform === "win32")
    throw new Error("Session locks are not supported on Windows yet");
  // Never through a symlink, and only a regular file: the lock writes nothing else.
  const fd = openSync(
    path,
    constants.O_WRONLY |
      constants.O_CREAT |
      constants.O_APPEND |
      constants.O_NOFOLLOW,
    0o600,
  );
  let kept = false;
  try {
    if (!fstatSync(fd).isFile())
      throw new Error("The session lock is not a regular file");
    const libc = dlopen(
      process.platform === "darwin" ? "libc.dylib" : "libc.so.6",
      { flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 } },
    );
    try {
      if (libc.symbols.flock(fd, LOCK_EX | LOCK_NB) !== 0) return undefined;
    } finally {
      libc.close();
    }
    // Who holds it, for people reading the registry; the lock itself is the open file.
    ftruncateSync(fd, 0);
    writeSync(fd, content);
    kept = true;
    return () => closeSync(fd);
  } finally {
    if (!kept) closeSync(fd);
  }
}
