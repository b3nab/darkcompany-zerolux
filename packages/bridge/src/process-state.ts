// Metadata only: ESRCH is the only negative proof. Permission errors are ambiguity.
export function processExists(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0)
    throw new Error("Invalid native process identity");
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}
