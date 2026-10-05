import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

test("the extension carries the one product version from the workspace Cargo.toml", () => {
  const cargo = readFileSync(
    new URL("../../../Cargo.toml", import.meta.url),
    "utf8",
  );
  const workspace =
    /\[workspace\.package\][^[]*?\bversion\s*=\s*"([^"]+)"/.exec(cargo)?.[1];
  const pkg = JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf8"),
  ) as { version: string };
  expect(workspace).toBeString();
  expect(pkg.version).toBe(workspace!);
});
