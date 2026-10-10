import { mkdir, open, realpath, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import {
  getAgentDir,
  SessionManager,
  VERSION,
} from "@earendil-works/pi-coding-agent";
import { savePiProfile } from "./execution-profile.ts";
import type { PiRunnerConfig } from "./runner.ts";

/** One explicit creation request. Native SDK generates the identity/header; no recovery use. */
export async function newPiSession(
  workspace: string,
  entry: string,
  pi: string,
): Promise<PiRunnerConfig> {
  workspace = await realpath(workspace);
  const extension = join(
    dirname(entry),
    entry.endsWith(".ts") ? "chat-extension.ts" : "chat-extension.js",
  );
  if (!(await stat(extension)).isFile())
    throw new Error(
      "The pi chat extension is not installed on this execution host",
    );
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
  };
}
