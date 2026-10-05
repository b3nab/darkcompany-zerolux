// Autowake: a note left before a reload, delivered to the model once pi is back, so the
// agent carries on by itself instead of waiting for a person to write.
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const DEFAULT_WAKE =
  "Reload done: the extensions are loaded again. Continue where you left off.";

export function wakeFile(dir: string, sessionId: string): string {
  return join(dir, `${sessionId}.txt`);
}

/** Leave the note for this session. The next reload of the same session delivers it. */
export async function leaveWake(
  dir: string,
  sessionId: string,
  text: string,
): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(wakeFile(dir, sessionId), text);
}

/** Take the note left for this session, if any, so it is delivered once. */
export async function takeWake(
  dir: string,
  sessionId: string,
): Promise<string | undefined> {
  const file = wakeFile(dir, sessionId);
  try {
    const text = await readFile(file, "utf8");
    await rm(file, { force: true });
    return text;
  } catch {
    return undefined;
  }
}

export function wakeMessage(then: string | undefined): string {
  const text = then?.trim();
  return `[autowake] ${text || DEFAULT_WAKE}`;
}

/** Registers the session_start handler; returns the function that leaves a note. */
export function installWake(
  pi: ExtensionAPI,
  dir: string,
): (sessionId: string, then: string | undefined) => Promise<void> {
  pi.on("session_start", async (event, ctx) => {
    if (event.reason !== "reload") return;
    const note = await takeWake(dir, ctx.sessionManager.getSessionId());
    if (note) pi.sendUserMessage(note, { expandPromptTemplates: false });
  });
  return (sessionId, then) => leaveWake(dir, sessionId, wakeMessage(then));
}
