import { mkdir, open, realpath, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import {
  getAgentDir,
  SessionManager,
  VERSION,
} from "@earendil-works/pi-coding-agent";
import { savePiProfile } from "./execution-profile.ts";
import type { PiRunnerConfig } from "./runner.ts";
import { settingsPatch } from "@zerolux/bridge";

async function chatExtension(entry: string) {
  const extension = join(
    dirname(entry),
    entry.endsWith(".ts") ? "chat-extension.ts" : "chat-extension.js",
  );
  if (!(await stat(extension)).isFile())
    throw new Error(
      "The pi chat extension is not installed on this execution host",
    );
  return extension;
}

/** One explicit creation request. Native SDK generates the identity/header; no recovery use. */
export async function newPiSession(
  workspace: string,
  entry: string,
  pi: string,
  settings: unknown = {},
): Promise<PiRunnerConfig> {
  const initial = settingsPatch(settings, ["model", "effort"]);
  workspace = await realpath(workspace);
  const extension = await chatExtension(entry);
  await mkdir(getAgentDir(), { recursive: true, mode: 0o700 });
  let sessionDir: string | undefined;
  if (process.env.PI_CODING_AGENT_SESSION_DIR) {
    sessionDir = resolve(workspace, process.env.PI_CODING_AGENT_SESSION_DIR);
    await mkdir(sessionDir, { recursive: true, mode: 0o700 });
    sessionDir = await realpath(sessionDir);
  }
  const manager = SessionManager.create(workspace, sessionDir);
  let file = manager.getSessionFile();
  const header = manager.getHeader();
  if (!file || !header)
    throw new Error("Native pi did not allocate a persistent session");
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  const handle = await open(file, "wx", 0o600);
  try {
    await handle.writeFile(JSON.stringify(header) + "\n");
    await handle.sync();
  } finally {
    await handle.close();
  }
  const directory = await open(dirname(file), "r");
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
  file = await realpath(file);
  const nativeSessionId = manager.getSessionId();
  const profile = await savePiProfile({
    version: 1,
    nativeSessionId,
    file,
    workspace,
    agentDir: await realpath(getAgentDir()),
    cliVersion: VERSION,
    lastPid: process.pid,
    args: ["--extension", extension],
    ...(sessionDir ? { sessionDir } : {}),
    ...(process.env.PI_OFFLINE !== undefined
      ? { offline: process.env.PI_OFFLINE }
      : {}),
  });
  return {
    nativeSessionId,
    file,
    workspace,
    profile,
    pi,
    entry,
    creation: true,
    initial,
  };
}

/**
 * A saved session the owner opens in ZeroLux: its own file, identity and folder, with the
 * chat extension. Its saved model and history are checked before native pi starts.
 */
export async function openPiSession(
  file: string,
  workspace: string,
  entry: string,
  pi: string,
): Promise<PiRunnerConfig> {
  const extension = await chatExtension(entry);
  file = await realpath(file);
  const handle = await open(file, "r");
  let header: { type?: unknown; id?: unknown; cwd?: unknown };
  try {
    const head = Buffer.alloc(64 * 1024);
    const { bytesRead } = await handle.read(head, 0, head.length, 0);
    header = JSON.parse(
      head.subarray(0, bytesRead).toString("utf8").split("\n")[0]!,
    );
  } finally {
    await handle.close();
  }
  if (
    header.type !== "session" ||
    typeof header.id !== "string" ||
    typeof header.cwd !== "string" ||
    (await realpath(header.cwd)) !== workspace
  )
    throw new Error("The saved pi session does not name this folder");
  const profile = await savePiProfile({
    version: 1,
    nativeSessionId: header.id,
    file,
    workspace,
    agentDir: await realpath(getAgentDir()),
    cliVersion: VERSION,
    lastPid: process.pid,
    args: ["--extension", extension],
    ...(process.env.PI_OFFLINE !== undefined
      ? { offline: process.env.PI_OFFLINE }
      : {}),
  });
  return {
    nativeSessionId: header.id,
    file,
    workspace,
    profile,
    pi,
    entry,
    opening: true,
  };
}
