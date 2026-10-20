/**
 * Whether a file's mode keeps it to its owner. On Windows modes do not apply: the user's
 * profile, where ZeroLux keeps its files, is private by its permissions.
 */
export const privateMode = (mode: number) =>
  process.platform === "win32" || (mode & 0o077) === 0;
