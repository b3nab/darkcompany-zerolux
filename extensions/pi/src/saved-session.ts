import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open, realpath, stat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import {
  CURRENT_SESSION_VERSION,
  SessionManager,
} from "@earendil-works/pi-coding-agent";

export interface PiInitialState {
  model: { provider: string; id: string };
  thinking: string;
}
export interface PiHistorySnapshot {
  nativeSessionId: string;
  workspace: string;
  file: string;
  history: { device: number; inode: number; bytes: number; sha256: string };
}
export type SavedPiSession = PiHistorySnapshot & PiInitialState;
export function validPiState(
  state: PiInitialState | undefined,
): state is PiInitialState {
  return Boolean(
    state?.model &&
    [state.model.provider, state.model.id].every(
      (value) =>
        typeof value === "string" &&
        value.length > 0 &&
        !/[\u0000-\u001f\u007f]/.test(value),
    ) &&
    ["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(
      state.thinking,
    ),
  );
}

/**
 * Read only, on the execution host, while its caller owns the execution lease.
 * Never use SessionManager.open for preflight: a missing file starts a new identity,
 * and an old/empty file can be rewritten before the caller can inspect the result.
 * Message contents remain in this process; only native identity/profile metadata returns.
 */
async function inspectPi(
  file: string,
  nativeSessionId: string,
  workspace: string,
) {
  if (!isAbsolute(file) || !isAbsolute(workspace) || !nativeSessionId)
    throw new Error(
      "Pi restoration requires an exact session file, identity and workspace",
    );
  const cwd = await realpath(workspace);
  if (!(await stat(cwd)).isDirectory())
    throw new Error("The saved pi workspace is not a directory");
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.nlink !== 1 || before.size === 0)
      throw new Error(
        "The saved pi history is empty or is not an unaliased regular file",
      );
    const bytes = await handle.readFile();
    const after = await handle.stat();
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs)
      throw new Error("The saved pi history changed during preflight");
    const entries: unknown[] = new TextDecoder("utf-8", { fatal: true })
      .decode(bytes)
      .split("\n")
      .filter((line) => line.trim())
      .map((line) => JSON.parse(line));
    const header = entries[0] as Record<string, unknown> | undefined;
    if (
      !header ||
      header.type !== "session" ||
      header.id !== nativeSessionId ||
      typeof header.cwd !== "string" ||
      (await realpath(header.cwd)) !== cwd
    )
      throw new Error(
        "The saved pi history does not name this session and workspace",
      );
    if (header.version !== CURRENT_SESSION_VERSION)
      throw new Error(
        "The saved pi format needs native compatibility verification before restoration",
      );
    // Do not let the SDK's tolerant JSONL loader silently drop malformed history or
    // reinterpret a disconnected branch. We do not duplicate its context reconstruction.
    const ids = new Set<string>();
    for (const value of entries.slice(1)) {
      if (!value || typeof value !== "object" || Array.isArray(value))
        throw new Error("Invalid pi history entry");
      const entry = value as Record<string, unknown>;
      if (
        entry.type === "session" ||
        typeof entry.type !== "string" ||
        typeof entry.id !== "string" ||
        !entry.id ||
        ids.has(entry.id) ||
        (entry.parentId !== null &&
          (typeof entry.parentId !== "string" || !ids.has(entry.parentId)))
      )
        throw new Error("Invalid pi history identity or branch");
      ids.add(entry.id);
    }
    const manager = SessionManager.inMemory(
      cwd,
      undefined,
      entries as NonNullable<Parameters<typeof SessionManager.inMemory>[2]>,
    );
    const context = manager.buildSessionContext();
    if (manager.getSessionId() !== nativeSessionId)
      throw new Error("Invalid native pi identity");
    const canonical = await realpath(file);
    const current = await stat(canonical);
    if (
      current.dev !== before.dev ||
      current.ino !== before.ino ||
      current.size !== before.size ||
      current.mtimeMs !== before.mtimeMs
    )
      throw new Error("The saved pi file was replaced during preflight");
    return {
      nativeSessionId,
      workspace: cwd,
      file: canonical,
      context,
      entries: entries.length,
      history: {
        device: before.dev,
        inode: before.ino,
        bytes: before.size,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      },
    };
  } finally {
    await handle.close();
  }
}

export async function readSavedPi(
  file: string,
  nativeSessionId: string,
  workspace: string,
): Promise<SavedPiSession> {
  const {
    context,
    entries: _entries,
    ...history
  } = await inspectPi(file, nativeSessionId, workspace);
  const state = context.model
    ? {
        model: { provider: context.model.provider, id: context.model.modelId },
        thinking: context.thinkingLevel,
      }
    : undefined;
  if (!validPiState(state))
    throw new Error(
      "The saved pi model is missing or invalid; no default or replacement was selected",
    );
  return { ...history, ...state };
}

/** Creation only: the exact SDK-generated header, with no recovered or fabricated entries. */
export async function readNewPi(
  file: string,
  nativeSessionId: string,
  workspace: string,
): Promise<PiHistorySnapshot> {
  const {
    context: _context,
    entries,
    ...history
  } = await inspectPi(file, nativeSessionId, workspace);
  if (entries !== 1)
    throw new Error("New pi history changed before native startup");
  return history;
}

/** Immediately before launching native pi; callers still hold the same execution lease. */
export async function checkSavedPi(snapshot: SavedPiSession) {
  const current = await readSavedPi(
    snapshot.file,
    snapshot.nativeSessionId,
    snapshot.workspace,
  );
  if (JSON.stringify(current) !== JSON.stringify(snapshot))
    throw new Error(
      "The saved pi context changed before launch; no process was started",
    );
}
