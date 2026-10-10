// Native launch configuration stays on the execution host, never in a chat or kernel row.
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, realpath, rename, unlink } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";

export interface PiExecutionProfile {
  version: 1;
  nativeSessionId: string;
  file: string;
  workspace: string;
  agentDir: string;
  cliVersion: string;
  lastPid: number;
  /** Only native configuration; no initial prompt, session selector or credential. */
  args: string[];
  sessionDir?: string;
  offline?: string;
  unavailable?: string;
}

const values = new Set([
  "--models",
  "--tools",
  "-t",
  "--exclude-tools",
  "-xt",
  "--extension",
  "-e",
  "--skill",
  "--prompt-template",
  "--theme",
  "--use-theme",
  "--system-prompt",
  "--append-system-prompt",
  "--session-dir",
]);
const flags = new Set([
  "--no-builtin-tools",
  "-nbt",
  "--no-tools",
  "-nt",
  "--no-extensions",
  "-ne",
  "--no-skills",
  "-ns",
  "--no-prompt-templates",
  "-np",
  "--no-themes",
  "--no-context-files",
  "-nc",
  "--approve",
  "-a",
  "--no-approve",
  "-na",
  "--offline",
]);
const selectors = new Set([
  "--session",
  "--session-id",
  "--fork",
  "--model",
  "--provider",
  "--thinking",
  "--mode",
  "--name",
  "-n",
  "--tui-mode",
]);
const display = new Set([
  "-p",
  "--print",
  "-c",
  "--continue",
  "-r",
  "--resume",
  "--verbose",
]);

/** Strip controller selection and initial work, never replay it on recovery. */
export function piResumeArgs(argv: readonly string[]): string[] {
  const result: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--") break; // Everything following it is initial work, not configuration.
    if (!arg.startsWith("-")) continue; // Includes @files and positional prompts.
    if (arg === "--api-key" || arg.startsWith("--api-key="))
      throw new Error(
        "pi used a non-persistent API key; it was not saved for recovery",
      );
    if (arg === "--no-session")
      throw new Error(
        "An in-memory pi session has no saved history to restore",
      );
    if (display.has(arg)) continue;
    if (selectors.has(arg)) {
      if (argv[++i] === undefined)
        throw new Error("Incomplete native pi options");
      continue;
    }
    if (flags.has(arg)) {
      result.push(arg);
      continue;
    }
    if (values.has(arg)) {
      const value = argv[++i];
      if (value === undefined) throw new Error("Incomplete native pi options");
      result.push(arg, value);
      continue;
    }
    // An extension flag can itself be initial work or a runtime credential. Without a
    // native replay-safe contract, neither discard it nor execute it again on recovery.
    throw new Error(
      "An unsupported native pi option prevents profile restoration",
    );
  }
  return result;
}

function validProfile(value: unknown): value is PiExecutionProfile {
  if (!value || typeof value !== "object") return false;
  const p = value as PiExecutionProfile;
  return (
    p.version === 1 &&
    typeof p.cliVersion === "string" &&
    !!p.cliVersion &&
    Number.isInteger(p.lastPid) &&
    p.lastPid > 0 &&
    typeof p.nativeSessionId === "string" &&
    !!p.nativeSessionId &&
    [p.file, p.workspace, p.agentDir].every(
      (v) => typeof v === "string" && isAbsolute(v),
    ) &&
    Array.isArray(p.args) &&
    p.args.every((arg) => typeof arg === "string" && !arg.includes("\0")) &&
    (p.sessionDir === undefined ||
      (typeof p.sessionDir === "string" && isAbsolute(p.sessionDir))) &&
    (p.offline === undefined || typeof p.offline === "string") &&
    (p.unavailable === undefined || typeof p.unavailable === "string")
  );
}

/** Write atomically under the native host's private agent directory. Caller holds its lease. */
export async function savePiProfile(
  profile: PiExecutionProfile,
): Promise<string> {
  if (!validProfile(profile))
    throw new Error("Invalid native pi execution profile");
  const serialized = JSON.stringify(profile) + "\n";
  if (Buffer.byteLength(serialized) > 64 * 1024)
    throw new Error("The native pi execution profile is too large");
  const root = join(await realpath(profile.agentDir), "zerolux-profiles");
  await mkdir(root, { recursive: true, mode: 0o700 });
  const info = await lstat(root);
  if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077) !== 0)
    throw new Error(
      "Pi profiles require a private directory on the execution host",
    );
  const key = createHash("sha256")
    .update(JSON.stringify([profile.nativeSessionId, profile.file]))
    .digest("hex");
  const path = join(root, `${key}.json`);
  const temporary = join(root, `.${key}-${randomUUID()}`);
  try {
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(serialized);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, path);
    const directory = await open(root, "r");
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  } finally {
    await unlink(temporary).catch(() => {});
  }
  return path;
}

export async function loadPiProfile(
  path: string,
  expected: { nativeSessionId: string; workspace: string; file: string },
): Promise<PiExecutionProfile> {
  if (!isAbsolute(path)) throw new Error("Pi profile path must be absolute");
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    if (
      !info.isFile() ||
      info.nlink !== 1 ||
      (info.mode & 0o077) !== 0 ||
      info.size > 64 * 1024
    )
      throw new Error("Pi profile is not a bounded private regular file");
    const profile: unknown = JSON.parse(await handle.readFile("utf8"));
    if (
      !validProfile(profile) ||
      profile.nativeSessionId !== expected.nativeSessionId ||
      profile.file !== expected.file ||
      profile.workspace !== expected.workspace ||
      dirname(await realpath(path)) !==
        join(await realpath(profile.agentDir), "zerolux-profiles")
    )
      throw new Error(
        "The saved pi execution profile does not match the entrusted session",
      );
    if (profile.unavailable) throw new Error(profile.unavailable);
    if (
      JSON.stringify(piResumeArgs(profile.args)) !==
      JSON.stringify(profile.args)
    )
      throw new Error(
        "The saved pi profile contains initial work or a session selector",
      );
    return profile;
  } finally {
    await handle.close();
  }
}
