import { afterEach, expect, test } from "bun:test";
import { setKernelFetch } from "./client";
import {
  chooseVoice,
  designVoice,
  forgetVoice,
  readAloud,
  spoken,
  transcribe,
} from "./voice";

afterEach(() => setKernelFetch());

const kernel = "http://192.0.2.4:4400";

/** A voice extension that answers each action with `answer`, noting what it was asked. */
function fake(
  answer: (name: string, input: Record<string, string>) => unknown,
) {
  const asked: { name: string; input: Record<string, string> }[] = [];
  setKernelFetch(async (url, init) => {
    const name = new URL(String(url)).pathname.split("/").pop() ?? "";
    const input = JSON.parse(String(init?.body)) as Record<string, string>;
    asked.push({ name, input });
    return Response.json({ result: await answer(name, input) });
  });
  return asked;
}

test("a recording goes to the voice extension in base64, and its text comes back", async () => {
  const asked = fake(() => ({ text: "Hello, aspen", language: "en" }));
  const said = await transcribe(
    new Blob([new Uint8Array([0, 1, 2, 250, 255])], { type: "audio/mp4" }),
    kernel,
  );
  expect(said).toBe("Hello, aspen");
  expect(asked).toEqual([{ name: "transcribe", input: { audio: "AAEC+v8=" } }]);
});

test("a text is read aloud piece by piece, the next asked for before the last plays", async () => {
  const asked = fake((name, input) =>
    name === "sentences"
      ? { sentences: ["One.", "Two.", "Three."] }
      : { audio: btoa(input.text ?? ""), type: "audio/wav" },
  );
  const heard: string[] = [];
  for await (const piece of readAloud(
    "birch",
    "One. Two. Three.",
    undefined,
    kernel,
  )) {
    heard.push(atob(piece.audio));
    // The next sentence is on its way while this one plays.
    expect(asked.length).toBe(Math.min(heard.length + 2, 4));
  }
  expect(heard).toEqual(["One.", "Two.", "Three."]);
  expect(asked.map((a) => a.input)).toEqual([
    { text: "One. Two. Three." },
    { actor_id: "birch", text: "One." },
    { actor_id: "birch", text: "Two." },
    { actor_id: "birch", text: "Three." },
  ]);
});

test("stopping a reading leaves the next piece unheard and unthrown", async () => {
  const stop = new AbortController();
  fake((name, input) =>
    name === "sentences"
      ? { sentences: ["One.", "Two."] }
      : input.text === "Two."
        ? Promise.reject(new Error("stopped"))
        : { audio: "", type: "audio/wav" },
  );
  for await (const _ of readAloud("birch", "One. Two.", stop.signal, kernel)) {
    stop.abort();
    break;
  }
  await Bun.sleep(0);
});

test("an agent's voice is designed, chosen and forgotten through its actions", async () => {
  const asked = fake((name) =>
    name === "design"
      ? { proposals: [{ id: "0a1b2c3d", audio: "", type: "audio/wav" }] }
      : name === "choose"
        ? { voice: { actor_id: "birch", description: "calm", language: "it" } }
        : { forgotten: true },
  );
  const [proposal] = await designVoice("birch", "calm", undefined, kernel);
  expect((await chooseVoice("birch", proposal!.id, kernel)).description).toBe(
    "calm",
  );
  await forgetVoice("birch", kernel);
  expect(asked).toEqual([
    { name: "design", input: { actor_id: "birch", description: "calm" } },
    { name: "choose", input: { actor_id: "birch", proposal: "0a1b2c3d" } },
    { name: "forget", input: { actor_id: "birch" } },
  ]);
});

/** Where a recording went: the box, a sent message, or kept as a file. */
function targets(transcription = true) {
  const went: string[] = [];
  return {
    went,
    write: (said: string) => void went.push(`write ${said}`),
    send: async (said: string) => void went.push(`send ${said}`),
    keep: async () => void went.push("keep"),
    transcription,
  };
}

const recording = new Blob([new Uint8Array([1, 2, 3])], { type: "audio/mp4" });

test("dictated words go to the box, and a message is kept, then sent as said", async () => {
  fake(() => ({ text: " Run the tests " }));
  const dictation = targets();
  await spoken("dictation", recording, dictation, kernel);
  expect(dictation.went).toEqual(["write Run the tests"]);
  const message = targets();
  await spoken("message", recording, message, kernel);
  expect(message.went).toEqual(["keep", "send Run the tests"]);
});

test("without transcription a message is only kept, and silence goes nowhere", async () => {
  const asked = fake(() => ({ text: "  " }));
  const kept = targets(false);
  await spoken("message", recording, kept, kernel);
  expect(kept.went).toEqual(["keep"]);
  expect(asked).toEqual([]);
  const silent = targets();
  await spoken("dictation", recording, silent, kernel);
  expect(silent.went).toEqual([]);
});

test("a failed transcription throws and leaves the box as it was", async () => {
  setKernelFetch(async () =>
    Response.json({ error: "The voice is starting" }, { status: 503 }),
  );
  const box = targets();
  await expect(spoken("dictation", recording, box, kernel)).rejects.toThrow();
  expect(box.went).toEqual([]);
});
