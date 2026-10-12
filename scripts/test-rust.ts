// The full gate must exercise both supported stores, never replace SQLite with PG.
import "./require-test-postgres.ts";

const sqlite = { ...process.env };
delete sqlite.ZEROLUX_TEST_POSTGRES_URL;
for (const [label, args, env] of [
  ["SQLite", ["test", "--workspace"], sqlite],
  [
    "PostgreSQL",
    ["test", "-p", "zerolux", "--", "--test-threads=4"],
    process.env,
  ],
] as const) {
  console.log(`\n=== Rust: ${label} ===`);
  const child = Bun.spawn(["cargo", ...args], {
    env,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  let cancelled = 0;
  const interrupt = () => {
    cancelled = 130;
    child.kill("SIGINT");
  };
  const terminate = () => {
    cancelled = 143;
    child.kill("SIGTERM");
  };
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", terminate);
  const status = await child.exited;
  process.off("SIGINT", interrupt);
  process.off("SIGTERM", terminate);
  if (cancelled || status !== 0) process.exit(cancelled || status);
}
