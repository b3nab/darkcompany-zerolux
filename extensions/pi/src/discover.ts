import { basename } from "node:path";
import {
  SessionManager,
  type SessionInfo,
} from "@earendil-works/pi-coding-agent";

/** SDK returns transcript-derived fields too; whitelist metadata before it leaves pi. */
export function sessionMetadata(info: SessionInfo) {
  const modified = info.modified.getTime();
  return {
    native_session_id: info.id,
    title: info.name || `pi — ${basename(info.cwd) || "session"}`,
    workspace: info.cwd,
    last_activity_at: Number.isFinite(modified) ? modified : null,
    path: info.path, // Private locator for the kernel, never part of its public discovery DTO.
  };
}

export async function listMetadata(sessionDir?: string) {
  const sessions = sessionDir
    ? await SessionManager.listAll(
        sessionDir,
        undefined,
        AbortSignal.timeout(10_000),
      )
    : await SessionManager.listAll(undefined, AbortSignal.timeout(10_000));
  return sessions.map(sessionMetadata);
}
