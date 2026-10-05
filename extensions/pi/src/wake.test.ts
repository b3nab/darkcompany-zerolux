import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  DEFAULT_WAKE,
  installWake,
  leaveWake,
  takeWake,
  wakeFile,
  wakeMessage,
} from "./wake.ts";

async function withDir(work: (dir: string) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), "zerolux-wake-"));
  try {
    await work(join(dir, "wake"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** A fake pi: records session_start handlers and user messages. */
function fakePi() {
  const handlers: ((event: any, ctx: any) => Promise<void>)[] = [];
  const sent: { text: string; options: unknown }[] = [];
  const pi = {
    on: (name: string, handler: (event: any, ctx: any) => Promise<void>) => {
      if (name === "session_start") handlers.push(handler);
    },
    sendUserMessage: (text: string, options: unknown) => {
      sent.push({ text, options });
    },
  } as unknown as ExtensionAPI;
  const start = (reason: string, sessionId: string) =>
    Promise.all(
      handlers.map((handler) =>
        handler(
          { type: "session_start", reason },
          {
            sessionManager: { getSessionId: () => sessionId },
          },
        ),
      ),
    );
  return { pi, sent, start };
}

test("a note is left per session, taken once, and absent when none was left", async () => {
  await withDir(async (dir) => {
    expect(await takeWake(dir, "a")).toBeUndefined();
    await leaveWake(dir, "a", "note a");
    await leaveWake(dir, "b", "note b");
    expect(await readFile(wakeFile(dir, "a"), "utf8")).toBe("note a");
    expect(await takeWake(dir, "a")).toBe("note a");
    expect(await takeWake(dir, "a")).toBeUndefined();
    expect(await takeWake(dir, "b")).toBe("note b");
  });
});

test("the wake message carries the note, or the default when empty", () => {
  expect(wakeMessage("Finish the search")).toBe("[autowake] Finish the search");
  expect(wakeMessage("  ")).toBe(`[autowake] ${DEFAULT_WAKE}`);
  expect(wakeMessage(undefined)).toBe(`[autowake] ${DEFAULT_WAKE}`);
});

test("after a reload the note of that session is sent as a user message, once", async () => {
  await withDir(async (dir) => {
    const { pi, sent, start } = fakePi();
    const leave = installWake(pi, dir);
    await leave("s1", "Continue the pi research");
    await start("startup", "s1");
    expect(sent).toEqual([]);
    await start("reload", "other");
    expect(sent).toEqual([]);
    await start("reload", "s1");
    expect(sent).toEqual([
      {
        text: "[autowake] Continue the pi research",
        options: { expandPromptTemplates: false },
      },
    ]);
    await start("reload", "s1");
    expect(sent).toHaveLength(1);
  });
});
