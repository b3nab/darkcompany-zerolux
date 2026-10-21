/**
 * Lets go of build output nobody uses anymore: what Cargo made more than `days` days ago (3 by
 * default) in `target/debug`, which it never deletes itself. The desktop app built in
 * `target/debug/bundle` stays.
 *
 *   bun scripts/sweep-target.ts [days]
 */
import { readdir, rm, stat } from "node:fs/promises";
import { join, resolve } from "node:path";

const days = Number(process.argv[2] ?? 3);
if (!Number.isFinite(days) || days < 0)
  throw new Error("Give a number of days");
const before = Date.now() - days * 24 * 60 * 60 * 1000;
const debug = resolve(import.meta.dir, "../target/debug");

let freed = 0;
let files = 0;
for (const folder of [
  "deps",
  "build",
  "incremental",
  ".fingerprint",
  "examples",
]) {
  const root = join(debug, folder);
  const entries = await readdir(root).catch(() => [] as string[]);
  for (const name of entries) {
    const path = join(root, name);
    const found = await stat(path).catch(() => undefined);
    if (!found || found.mtimeMs >= before) continue;
    freed += found.isDirectory() ? 0 : found.size;
    files++;
    await rm(path, { recursive: true, force: true });
  }
}
console.log(
  `${files} entries older than ${days} days removed, ${(freed / 1e9).toFixed(1)} GB of files`,
);
