// A disposable host and child for the crash/lease test. No Claude, SDK query or model.
import { join, resolve } from "node:path";
import { acquireSessionLock } from "@zerolux/bridge/session-lock";
import { ClaudeExecution } from "../execution.ts";

const root = process.argv[2]!;
const lock = acquireSessionLock(join(root, "session.lock"));
if (!lock) throw new Error("fixture lease already held");
const execution = new ClaudeExecution(
  lock,
  {
    nativeSessionId: "native",
    workspace: root,
    instanceId: "crash-fixture",
  },
  resolve(import.meta.dir, "../../../../packages/bridge/src/exec-gate.ts"),
);
const child = execution.spawn({
  command: process.execPath,
  args: [
    "-e",
    "console.log(process.pid); process.stdin.resume(); setInterval(() => {}, 1000)",
  ],
  cwd: root,
  env: { HOME: root, TMPDIR: root, PATH: "/usr/bin:/bin" },
  signal: new AbortController().signal,
});
child.stdout.pipe(process.stdout); // Only the fake child's PID.
