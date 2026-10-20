import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";

/**
 * Opens a file for reading, never through a link planted at its path. Windows has no
 * O_NOFOLLOW: there a link is refused before the file is opened.
 */
export async function openNoFollow(path: string) {
  if (process.platform === "win32") {
    if ((await lstat(path)).isSymbolicLink())
      throw new Error(`${path} is a link, not a file`);
    return open(path, constants.O_RDONLY);
  }
  return open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
}
