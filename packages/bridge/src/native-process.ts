/**
 * The native process as its host recorded it: this process, and the host that started it.
 * On Windows, which cannot exec in place, the gate the host recorded serves the native as its
 * child and names itself and its host in the environment.
 */
export function nativeProcess() {
  const pid = Number(process.env.ZEROLUX_NATIVE_PID);
  const parent = Number(process.env.ZEROLUX_NATIVE_PARENT);
  if (process.platform === "win32" && pid > 0 && parent > 0)
    return { pid, parent };
  return { pid: process.pid, parent: process.ppid };
}
