import { expect, test } from "bun:test";
import { join } from "node:path";
import { semver, versioned, withVersion } from "./release";

const root = join(import.meta.dir, "..");

test("every file the version lives in still says where it is", async () => {
  for (const [file] of versioned) {
    const text = await Bun.file(join(root, file)).text();
    expect(withVersion(file, text, "9.8.7")).toContain('"9.8.7"');
  }
});

test("only the workspace's version changes in Cargo.toml", () => {
  const text = `[workspace]\nmembers = ["a"]\n\n[workspace.package]\nedition = "2024"\nversion = "0.0.1-dev"\n\n[workspace.dependencies]\nserde = { version = "1" }\n`;
  const next = withVersion("Cargo.toml", text, "0.0.1");
  expect(next).toContain('version = "0.0.1"\n');
  expect(next).toContain('serde = { version = "1" }');
});

test("a release version is semver", () => {
  expect(semver.test("0.0.1")).toBe(true);
  expect(semver.test("0.1.0-rc.1")).toBe(true);
  expect(semver.test("0.1")).toBe(false);
  expect(semver.test("latest")).toBe(false);
});
