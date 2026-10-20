// A child of one kernel, not an independently supervised authentication daemon.
import { createServer, type AddressInfo } from "node:net";
import { createInterface } from "node:readline";
import { createAuth } from "./auth.ts";
import { parseConfig } from "./config.ts";

let auth: Awaited<ReturnType<typeof createAuth>> | undefined;
let server: ReturnType<typeof Bun.serve> | undefined;
let starting: Promise<void> | undefined;
let closing = false;
let stopping: Promise<void> | undefined;
let exitCode = 0;
let failureReported = false;
let stage: "config" | "database" | "listen" = "config";

function failed(error?: unknown) {
  // A machine-readable category, never the underlying error or configuration. Only a
  // listener's own error, which holds neither, goes to the log, to say why it could not listen.
  if (!failureReported) {
    failureReported = true;
    console.log(JSON.stringify({ type: "failed", version: 1, reason: stage }));
    console.error("ZeroLux authentication service failed to start");
    if (stage === "listen" && error instanceof Error)
      console.error(`${error.name}: ${error.message}`);
  }
  void stop(1);
}

function stop(code = 0) {
  if (code !== 0) exitCode = code;
  closing = true;
  return (stopping ??= (async () => {
    // Bound cleanup even if a database query or migration stops responding.
    // Parent disappearance must never leave this private child running.
    const deadline = setTimeout(() => process.exit(exitCode), 5_000);
    try {
      await starting?.catch(() => {});
      await server?.stop(true);
      await auth?.close();
    } catch {
      exitCode = 1;
      console.error("ZeroLux authentication service failed to stop");
    } finally {
      clearTimeout(deadline);
      process.exit(exitCode);
    }
  })());
}

/** A free loopback port: Bun on Windows cannot serve on port 0. */
function freePort() {
  return new Promise<number>((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address() as AddressInfo;
      probe.close(() => resolve(port));
    });
  });
}

async function start(line: string) {
  const config = parseConfig(JSON.parse(line));
  stage = "database";
  auth = await createAuth(config);
  if (closing) return;
  stage = "listen";
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: process.platform === "win32" ? await freePort() : 0,
    maxRequestBodySize: 64 * 1024,
    fetch: auth.fetch,
    error: () =>
      Response.json({ error: "Authentication unavailable" }, { status: 503 }),
  });
  console.log(
    JSON.stringify({
      type: "ready",
      version: 1,
      pid: process.pid,
      address: server.url.origin,
      workspace_id: config.workspace_id,
    }),
  );
}

const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
let configBytes = 0;
let received = false;
process.stdin.on("data", (chunk: Buffer) => {
  configBytes += chunk.length;
  if (configBytes > 64 * 1024) failed();
});
lines.on("line", (line) => {
  if (received || closing) {
    void stop(1);
    return;
  }
  received = true;
  if (Buffer.byteLength(line) > 64 * 1024) {
    failed();
    return;
  }
  starting = start(line);
  void starting.catch((error) => failed(error));
});
// EOF also arrives when the parent crashes: an orphan cannot retain the auth listener.
lines.on("close", () => {
  void stop();
});
process.on("SIGTERM", () => {
  void stop();
});
process.on("SIGINT", () => {
  void stop();
});
