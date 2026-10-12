// The full gate must not silently omit one of the supported databases.
const value = process.env.ZEROLUX_TEST_POSTGRES_URL;
if (!value) {
  throw new Error(
    "Set ZEROLUX_TEST_POSTGRES_URL to a disposable PostgreSQL instance before running the full check. Targeted SQLite tests can run without it.",
  );
}
try {
  const url = new URL(value);
  if (
    !["postgres:", "postgresql:"].includes(url.protocol) ||
    !url.hostname ||
    url.pathname.length < 2
  )
    throw new Error();
} catch {
  // Database URLs carry credentials: never echo the invalid value.
  throw new Error(
    "ZEROLUX_TEST_POSTGRES_URL must name a disposable PostgreSQL database",
  );
}
