import { afterEach, expect, test } from "bun:test";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
async function run(extra: Record<string, string> = {}) {
  const root = await mkdtemp(join(tmpdir(), "zerolux-rust-gate-"));
  roots.push(root);
  const cargo = join(root, "cargo");
  const log = join(root, "calls");
  await Bun.write(
    cargo,
    `#!/bin/sh\nprintf '%s:%s\\n' "$*" "\${ZEROLUX_TEST_POSTGRES_URL:+postgres}" >> "$CARGO_FIXTURE_LOG"\ncase "$*" in *--workspace*) exit "\${FAIL_SQLITE:-0}";; esac\nexit "\${FAIL_POSTGRES:-0}"\n`,
  );
  await chmod(cargo, 0o700);
  const env: Record<string, string | undefined> = {
    ...extra,
    PATH: `${root}:${process.env.PATH ?? ""}`,
    HOME: root,
    TMPDIR: root,
    CARGO_FIXTURE_LOG: log,
  };
  // Never inherit a real database URL. These tests execute only the fake cargo above.
  delete env.ZEROLUX_TEST_POSTGRES_URL;
  if (extra.ZEROLUX_TEST_POSTGRES_URL)
    env.ZEROLUX_TEST_POSTGRES_URL = extra.ZEROLUX_TEST_POSTGRES_URL;
  const child = Bun.spawn(
    [
      process.execPath,
      "--no-env-file",
      fileURLToPath(new URL("./test-rust.ts", import.meta.url)),
    ],
    {
      cwd: root,
      env,
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [status, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return {
    status,
    stdout,
    stderr,
    calls: (await Bun.file(log).exists()) ? await Bun.file(log).text() : "",
  };
}
// The fake cargo is a shell script.
const windows = process.platform === "win32";
const fixtureUrl = "postgresql://fixture:fixture-only@127.0.0.1:9/disposable";

test.skipIf(windows)(
  "the root Rust gate runs SQLite first and PostgreSQL second, without exposing the URL",
  async () => {
    const result = await run({ ZEROLUX_TEST_POSTGRES_URL: fixtureUrl });
    expect(result.status).toBe(0);
    expect(result.calls).toBe(
      "test --workspace:\ntest -p zerolux -- --test-threads=4:postgres\n",
    );
    expect(result.stdout).toContain("Rust: SQLite");
    expect(result.stdout).toContain("Rust: PostgreSQL");
    expect(result.stdout + result.stderr).not.toContain(fixtureUrl);
  },
);
test.skipIf(windows)(
  "a SQLite failure cannot be hidden by a later PostgreSQL success",
  async () => {
    const result = await run({
      ZEROLUX_TEST_POSTGRES_URL: fixtureUrl,
      FAIL_SQLITE: "7",
    });
    expect(result.status).toBe(7);
    expect(result.calls).toBe("test --workspace:\n");
  },
);
test.skipIf(windows)(
  "a PostgreSQL failure remains a failure after the SQLite pass",
  async () => {
    const result = await run({
      ZEROLUX_TEST_POSTGRES_URL: fixtureUrl,
      FAIL_POSTGRES: "9",
    });
    expect(result.status).toBe(9);
    expect(result.calls).toBe(
      "test --workspace:\ntest -p zerolux -- --test-threads=4:postgres\n",
    );
  },
);
test("a generic DATABASE_URL is never the test database fallback", async () => {
  const result = await run({ DATABASE_URL: fixtureUrl });
  expect(result.status).not.toBe(0);
  expect(result.calls).toBe("");
  expect(result.stdout + result.stderr).not.toContain(fixtureUrl);
});
test("invalid test configuration never prints credential-bearing input", async () => {
  const result = await run({
    ZEROLUX_TEST_POSTGRES_URL:
      "http://secret-user:secret-password@localhost/not-postgres",
  });
  expect(result.status).not.toBe(0);
  expect(result.calls).toBe("");
  expect(result.stdout + result.stderr).not.toContain("secret-password");
});
