// This child does no native work until its host has durably recorded this PID.
// Read exactly one LF-terminated record: buffered reads would swallow RPC commands
// that must remain on stdin across exec. No shell, prompt, credentials or retry logic.
import { readSync } from "node:fs";
import { isAbsolute } from "node:path";

export async function waitAndExec(harness = "pi") {
  const bytes: number[] = [];
  const byte = Buffer.alloc(1);
  while (true) {
    if (readSync(0, byte, 0, 1, null) === 0) return; // Host died before authorizing exec.
    if (byte[0] === 10) break;
    bytes.push(byte[0]!);
    if (bytes.length > 64 * 1024)
      throw new Error(`${harness} exec request is too large`);
  }
  const request: unknown = JSON.parse(
    new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(bytes)),
  );
  if (!request || typeof request !== "object")
    throw new Error(`Invalid ${harness} exec request`);
  const { exec, args } = request as Record<string, unknown>;
  if (
    typeof exec !== "string" ||
    !isAbsolute(exec) ||
    !Array.isArray(args) ||
    args.some((arg) => typeof arg !== "string" || arg.includes("\0"))
  )
    throw new Error(`Invalid ${harness} exec request`);
  if (process.platform === "win32") {
    // Windows cannot exec in place. The gate starts it as its child, on the same input and
    // output, and lives exactly as long as it does: the recorded PID stays the one whose
    // end is the native end, and ending the gate ends its child with it.
    const child = Bun.spawn([exec, ...(args as string[])], {
      stdio: ["inherit", "inherit", "inherit"],
      env: process.env,
    });
    process.exit(await child.exited);
  }
  if (!process.execve)
    throw new Error(
      `This host cannot exec ${harness} without changing its PID`,
    );
  process.execve(exec, [exec, ...(args as string[])], process.env);
}

if (import.meta.main) waitAndExec();
