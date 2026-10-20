import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const root = join(import.meta.dir, "../../..");

/** ZeroLux's own extensions carry the SDK of their language as `zerolux ext new` gives it. */
test("the extensions ZeroLux brings carry the SDK as it is", async () => {
  const typescript = await readFile(join(import.meta.dir, "index.ts"), "utf8");
  const python = await readFile(
    join(import.meta.dir, "../python/zerolux.py"),
    "utf8",
  );
  for (const [glob, sdk] of [
    ["marketplace/*/zerolux.ts", typescript],
    ["{marketplace,extensions}/*/zerolux.py", python],
  ] as const)
    for await (const path of new Bun.Glob(glob).scan({ cwd: root }))
      expect(await readFile(join(root, path), "utf8"), path).toBe(sdk);
});
