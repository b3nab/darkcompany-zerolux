import { afterEach, expect, spyOn, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import {
  saveDraft,
  setKernelFetch,
  useChat,
  useVoiceInput,
} from "@zerolux/chat";
import type { Chat, Recorder, VoiceTargets } from "@zerolux/chat";
import { workspaceNavigationGuard } from "./desktop";
import { guardNavigation, navigationBlock } from "./navigation-guard";

const cleanups: (() => void)[] = [];
afterEach(() => {
  cleanups
    .splice(0)
    .reverse()
    .forEach((stop) => stop());
  setKernelFetch();
  saveDraft("fixture-draft", "");
});

function chatFixture() {
  let chat!: Chat;
  function Probe() {
    chat = useChat(false, "https://fixture.example.test");
    return null;
  }
  renderToStaticMarkup(<Probe />);
  return chat;
}

function desktopFixture(chat: Chat) {
  const before = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { zeroluxDesktop: { profileId: "fixture", workspaceId: "fixture" } },
  });
  cleanups.push(() => {
    if (before) Object.defineProperty(globalThis, "window", before);
    else Reflect.deleteProperty(globalThis, "window");
  });
  cleanups.push(workspaceNavigationGuard(chat.canLeave, chat.leaveReason));
  return () => window.zeroluxWorkspaceState!();
}

test("restart refuses a Console input before a render, through failure and retry", async () => {
  // A known UUID lets the fixture exercise the same retry/remove action as the Console.
  const random = spyOn(crypto, "getRandomValues").mockImplementation(
    (array: Uint8Array) => {
      new Uint8Array(array!.buffer).fill(0);
      return array;
    },
  );
  cleanups.push(() => random.mockRestore());
  const id = "00000000-0000-4000-8000-000000000000";
  let answer = Promise.withResolvers<Response>();
  const requests: unknown[] = [];
  setKernelFetch(async (_url, init) => {
    requests.push(JSON.parse(String(init?.body)));
    return answer.promise;
  });
  const chat = chatFixture();
  const state = desktopFixture(chat);
  expect(state().canLeave).toBe(true);
  const sent = chat.input("session", "Keep this", "queue", [
    { data: "AA==", media_type: "image/png" },
  ]);
  expect(state().canLeave).toBe(false);
  answer.resolve(Response.json({ error: "fixture offline" }, { status: 503 }));
  await expect(sent).rejects.toThrow();
  expect(state().canLeave).toBe(false);
  answer = Promise.withResolvers<Response>();
  const retry = chat.retryInput(id);
  expect(state().canLeave).toBe(false);
  answer.resolve(Response.json({}));
  await retry;
  expect(state().canLeave).toBe(true);
  expect(requests).toHaveLength(2);
  expect(requests[1]).toEqual(requests[0]);

  answer = Promise.withResolvers<Response>();
  const failed = chat.input("session", "Discard this");
  answer.resolve(Response.json({ error: "fixture offline" }, { status: 503 }));
  await expect(failed).rejects.toThrow();
  chat.dropInput(id);
  expect(state().canLeave).toBe(true);
});

test("view guards aggregate local files and work in progress, keeping saved text", () => {
  const state = desktopFixture(chatFixture());
  saveDraft("fixture-draft", "Retained text");
  let files = true,
    uploading = true;
  const removeFiles = guardNavigation(() =>
    files ? "Attached files" : undefined,
  );
  const finishUpload = guardNavigation(() =>
    uploading ? "Uploading files" : undefined,
  );
  cleanups.push(removeFiles, finishUpload);
  expect(state().canLeave).toBe(false);
  files = false;
  expect(state().reason).toBe("Uploading files");
  uploading = false;
  expect(state()).toEqual({
    canLeave: true,
    reason: undefined,
    drafts: { "fixture-draft": "Retained text" },
  });
  uploading = true;
  finishUpload();
  expect(navigationBlock()).toBeUndefined();
  expect(state().canLeave).toBe(true);
});

function voiceFixture(recorder: Recorder, targets: VoiceTargets) {
  let speech!: ReturnType<typeof useVoiceInput>;
  function Probe() {
    speech = useVoiceInput(recorder, targets, "https://fixture.example.test");
    return null;
  }
  renderToStaticMarkup(<Probe />);
  return speech;
}

test("voice blocks restart from microphone startup through saving and sending without transcription", async () => {
  const started = Promise.withResolvers<void>();
  const kept = Promise.withResolvers<{ id: string; name: string }>();
  const sent = Promise.withResolvers<void>();
  const speech = voiceFixture(
    {
      start: () => started.promise,
      stop: async () => new Blob(["fixture"]),
      cancel: () => {},
    },
    {
      transcription: false,
      write: () => {},
      keep: () => kept.promise,
      send: () => sent.promise,
    },
  );
  const state = desktopFixture(chatFixture());
  const removeComposer = guardNavigation(() =>
    speech.pending()
      ? "Voice input is still recording or processing."
      : undefined,
  );
  cleanups.push(removeComposer);
  const opening = speech.start("message");
  expect(state().canLeave).toBe(false);
  started.resolve();
  await opening;
  const processing = speech.finish();
  // Opening another chat removes its composer, but the upload must still finish.
  removeComposer();
  expect(state().canLeave).toBe(false);
  kept.resolve({ id: "audio", name: "voice.webm" });
  await Promise.resolve();
  expect(state().canLeave).toBe(false);
  sent.resolve();
  await processing;
  expect(state().canLeave).toBe(true);
  await speech.start("message");
  speech.discard();
  expect(state().canLeave).toBe(true);
});

test("voice stays protected while transcribing, then releases on success or error", async () => {
  let response = Promise.withResolvers<Response>();
  setKernelFetch(async (url) =>
    url.endsWith("/prepare") ? Response.json({ result: {} }) : response.promise,
  );
  const written: string[] = [];
  const speech = voiceFixture(
    {
      start: async () => {},
      stop: async () => new Blob(["fixture"]),
      cancel: () => {},
    },
    {
      transcription: true,
      write: (text) => written.push(text),
      send: async () => {},
    },
  );
  await speech.start("dictation");
  const transcribing = speech.finish();
  expect(speech.pending()).toBe(true);
  response.resolve(Response.json({ result: { text: "Saved words" } }));
  await transcribing;
  expect(written).toEqual(["Saved words"]);
  expect(speech.pending()).toBe(false);
  response = Promise.withResolvers<Response>();
  await speech.start("dictation");
  const failed = speech.finish();
  response.resolve(
    Response.json({ error: "fixture unavailable" }, { status: 503 }),
  );
  await failed;
  expect(speech.pending()).toBe(false);
});
