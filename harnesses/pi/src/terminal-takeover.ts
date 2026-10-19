import { realpath } from "node:fs/promises";
import {
  getAgentDir,
  VERSION,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { loadPiProfile, piResumeArgs } from "./execution-profile.ts";
import { readSavedPi } from "./saved-session.ts";
import type { NativeMetadata } from "./managed.ts";

/** Read-only preflight. Never closes a terminal or opens a persistent session manager. */
export async function checkTerminalTakeover(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  metadata: NativeMetadata,
) {
  if (
    ctx.mode !== "tui" ||
    metadata.runner ||
    !ctx.isIdle() ||
    ctx.hasPendingMessages() ||
    ctx.ui.getEditorText() !== "" ||
    !metadata.session_file ||
    !metadata.profile
  )
    throw new Error(
      "Takeover requires an idle terminal pi with a saved launch profile",
    );
  const file = await realpath(ctx.sessionManager.getSessionFile()!);
  const workspace = await realpath(ctx.cwd);
  const native = ctx.sessionManager.getSessionId();
  if (file !== metadata.session_file)
    throw new Error("The entrusted pi history file changed");
  const profile = await loadPiProfile(metadata.profile, {
    nativeSessionId: native,
    workspace,
    file,
  });
  const saved = await readSavedPi(file, native, workspace);
  if (
    profile.lastPid !== process.pid ||
    profile.cliVersion !== VERSION ||
    profile.agentDir !== (await realpath(getAgentDir())) ||
    JSON.stringify(profile.args) !==
      JSON.stringify(piResumeArgs(process.argv.slice(2))) ||
    saved.model.provider !== ctx.model?.provider ||
    saved.model.id !== ctx.model?.id ||
    saved.thinking !== pi.getThinkingLevel() ||
    !ctx.model ||
    !ctx.modelRegistry.hasConfiguredAuth(ctx.model) ||
    !ctx.isIdle() ||
    ctx.hasPendingMessages() ||
    ctx.ui.getEditorText() !== ""
  )
    throw new Error(
      "Native pi cannot confirm its saved context and launch profile for takeover",
    );
}
