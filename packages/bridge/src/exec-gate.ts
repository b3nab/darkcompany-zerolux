// This child does no native work until its host has durably recorded this PID.
// Read exactly one LF-terminated record: buffered reads would swallow RPC commands
// that must remain on stdin across exec. No shell, prompt, credentials or retry logic.
import { readSync } from "node:fs";
import { isAbsolute, join } from "node:path";

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
    const child = Bun.spawn(windowsCommand(exec, args as string[]), {
      stdio: ["inherit", "inherit", "inherit"],
      env: process.env,
      windowsVerbatimArguments: /\.(cmd|bat)$/i.test(exec),
    });
    process.exit(await child.exited);
  }
  if (!process.execve)
    throw new Error(
      `This host cannot exec ${harness} without changing its PID`,
    );
  process.execve(exec, [exec, ...(args as string[])], process.env);
}

/**
 * A command file, such as the `pi.cmd` npm installs, runs through the command interpreter,
 * with its arguments quoted as one line; anything the interpreter would read as its own
 * (a quote, a `%`, a line break) is refused rather than escaped.
 */
function windowsCommand(exec: string, args: string[]) {
  if (!/\.(cmd|bat)$/i.test(exec)) return [exec, ...args];
  const parts = [exec, ...args];
  if (parts.some((part) => /["%\r\n]/.test(part)))
    throw new Error("This command cannot be passed to a command file safely");
  const line = parts.map((part) => `"${part}"`).join(" ");
  // The interpreter by its full path: the environment a host passes may not name it.
  const shell =
    process.env.ComSpec ??
    join(
      process.env.SystemRoot ?? process.env.windir ?? "C:\\Windows",
      "System32",
      "cmd.exe",
    );
  return [shell, "/d", "/s", "/c", `"${line}"`];
}

if (import.meta.main) waitAndExec();
