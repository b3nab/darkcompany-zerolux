import { mkdir, open, realpath, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { getAgentDir, SessionManager } from "@earendil-works/pi-coding-agent";
import type { PiRunnerConfig } from "./runner.ts";
import { settingsPatch } from "@zerolux/bridge";

/** ZeroLux's extension for pi, beside the host that starts it. */
export async function chatExtension(entry: string) {
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

/** A new session: pi's own SDK gives it its identity and its file, where pi then goes on. */
export async function newPiSession(
  workspace: string,
  entry: string,
  pi: string,
  settings: unknown = {},
): Promise<PiRunnerConfig> {
  const initial = settingsPatch(settings, ["model", "effort"]);
  workspace = await realpath(workspace);
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
  // Windows cannot open a folder to flush it; its file system journals the new file itself.
  if (process.platform !== "win32") {
    const directory = await open(dirname(file), "r");
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  }
  file = await realpath(file);
  return {
    nativeSessionId: manager.getSessionId(),
    file,
    workspace,
    pi,
    entry,
    creation: true,
    initial,
  };
}

/**
 * A copy of a saved session to go on from on its own: all of it, or the path up to one of its
 * entries. pi's own fork, in the session's folder: the new file and identity.
 */
export async function forkPiSession(
  file: string,
  workspace: string,
  upTo?: string,
): Promise<{ native_session_id: string; file: string }> {
  workspace = await realpath(workspace);
  let forked: string | undefined;
  if (upTo) {
    const manager = SessionManager.open(file);
    forked = manager.createBranchedSession(upTo);
    // pi writes a branch once it holds an answer; one that holds none is written here.
    if (forked && !(await stat(forked).catch(() => undefined))) {
      const lines = [manager.getHeader(), ...manager.getEntries()];
      await writeFile(
        forked,
        lines.map((line) => JSON.stringify(line)).join("\n") + "\n",
        { flag: "wx", mode: 0o600 },
      );
    }
  } else {
    const manager = SessionManager.forkFrom(file, workspace);
    forked = manager.getSessionFile();
  }
  if (!forked) throw new Error("pi did not save the fork");
  forked = await realpath(forked);
  const header = SessionManager.open(forked).getHeader();
  if (!header?.id) throw new Error("The fork has no identity");
  return { native_session_id: header.id, file: forked };
}
