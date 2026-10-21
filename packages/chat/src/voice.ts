import { useRef, useState } from "react";
import { errorMessage, kernelUrl } from "./client";
import {
  extensionsNotice,
  runAction,
  useActions,
  useKernelList,
} from "./extensions";
import type { FileLink } from "./storage";

/** The official extension that turns speech into text and gives agents their voices. */
export const VOICE = "zerolux.voice";

/** An agent's voice, as it was described. */
export interface Voice {
  actor_id: string;
  /** How it sounds, in English. */
  description: string;
  /** The language it speaks best. */
  language: string;
  created_at: number;
}

/** A piece of speech, its audio in base64. */
export interface Speech {
  audio: string;
  type: string;
  language: string;
  seconds: number;
}

/** One of the voices proposed for an agent, saying a greeting. */
export interface VoiceProposal {
  id: string;
  audio: string;
  type: string;
}

const voice = <T>(
  name: string,
  input: Record<string, unknown>,
  kernel: string,
  signal?: AbortSignal,
) => runAction(VOICE, name, input, kernel, signal) as Promise<T>;

/** A recording's bytes in base64: React Native's Blob gives them only to a FileReader. */
async function base64(audio: Blob) {
  if (typeof audio.arrayBuffer !== "function")
    return new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const url = String(reader.result);
        resolve(url.slice(url.indexOf(",") + 1));
      };
      reader.onerror = () => reject(new Error("The recording can't be read"));
      reader.readAsDataURL(audio);
    });
  const bytes = new Uint8Array(await audio.arrayBuffer());
  let binary = "";
  for (let at = 0; at < bytes.length; at += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(at, at + 0x8000));
  return btoa(binary);
}

const readVoices = (kernel: string) =>
  voice<{ voices: Voice[] }>("voices", {}, kernel).then((r) => r.voices);

/**
 * Whether the workspace has the voice, and the agents that have one: read again when
 * extensions change and when a voice is chosen or forgotten.
 */
export function useVoice(kernel = kernelUrl(), enabled = true) {
  const { actions } = useActions(kernel, enabled);
  const available = Boolean(
    actions?.some((a) => a.extension === VOICE && a.name === "transcribe"),
  );
  const { items, error } = useKernelList(readVoices, kernel, available);
  return { available, voices: items, error };
}

/** What was said in a recording, as text, with the workspace's names written right. */
export const transcribe = async (audio: Blob, kernel = kernelUrl()) =>
  (
    await voice<{ text: string }>(
      "transcribe",
      { audio: await base64(audio) },
      kernel,
    )
  ).text;

/** A microphone as a client records with it: one recording at a time. */
export interface Recorder {
  start(): Promise<void>;
  /** Ends the recording and gives its audio. */
  stop(): Promise<Blob | undefined>;
  /** Drops the recording. */
  cancel(): unknown;
}

/** What the microphone takes: words for the box, or a message sent as said. */
export type VoiceUse = "dictation" | "message";

export interface VoiceTargets {
  /** What was dictated, for the box. */
  write: (said: string) => void;
  /** What was recorded as a message: its words, and its recording where it was kept. */
  send: (said: string, kept?: FileLink) => Promise<void>;
  /** A message's recording, kept before it is transcribed: the file the message links. */
  keep?: (audio: Blob) => Promise<FileLink>;
  /** Whether the workspace transcribes: without it, a message is only kept. */
  transcription: boolean;
}

/** Dictated words after what the box holds. */
export const dictated = (text: string, said: string) =>
  text.trim() ? `${text.trimEnd()} ${said}` : said;

/**
 * A recording where it goes: dictated words to the box; a message kept first, then sent as
 * said with its recording, or with the recording alone when nothing is said. A failure
 * throws and leaves the box as it was.
 */
export async function spoken(
  use: VoiceUse,
  audio: Blob,
  { write, send, keep, transcription }: VoiceTargets,
  kernel = kernelUrl(),
) {
  const kept = use === "message" && keep ? await keep(audio) : undefined;
  let said = "";
  try {
    if (transcription) said = (await transcribe(audio, kernel)).trim();
  } catch (e) {
    // The recording is kept: the message goes with it alone.
    if (kept) await send("", kept);
    throw e;
  }
  if (use === "dictation") {
    if (said) write(said);
  } else if (said || kept) await send(said, kept);
}

/** The quietest and the loudest the microphone's level is drawn between, in dBFS. */
const QUIET = -55;
const LOUD = -10;

/**
 * How loud the microphone hears now, from its level in dBFS (-160 to 0, as iOS, Android and a
 * browser's analyser give it), as a bar's height from 0 to 1: speech fills it, silence keeps it
 * at the floor.
 */
export const audioLevel = (db: number) =>
  Math.min(1, Math.max(0, (db - QUIET) / (LOUD - QUIET)));

/** How long a press on Dictate or Record lasts before its release ends the recording. */
export const HOLD_MS = 300;

/**
 * Whether releasing Dictate or Record ends the recording: after a hold, as a walkie-talkie;
 * after any press that came while it was recording. A tap that started it keeps it going.
 */
export const endsOnRelease = (
  press: { at: number; recording: boolean },
  now = Date.now(),
) => press.recording || now - press.at >= HOLD_MS;

/**
 * Speaking into a composer, Dictate or Record: what it records for, `transcribing` until
 * the text comes (seconds the first time), and what went wrong, in a sentence. A tap starts
 * recording until a press ends it; a hold records until it is released.
 */
export function useVoiceInput(
  recorder: Recorder,
  targets: VoiceTargets,
  kernel = kernelUrl(),
) {
  const [use, setUse] = useState<VoiceUse>();
  const [transcribing, setTranscribing] = useState(false);
  const [error, setError] = useState("");
  // What records now, for a release that comes before the next render.
  const recording = useRef<VoiceUse | "starting">(undefined);
  const pressed = useRef({ at: 0, recording: false });
  // Ended while the microphone was still starting: it ends as soon as it records.
  const ending = useRef(false);
  const start = async (next: VoiceUse) => {
    setError("");
    recording.current = "starting";
    ending.current = false;
    try {
      await recorder.start();
    } catch (e) {
      recording.current = undefined;
      setError(`The microphone is not available: ${errorMessage(e)}`);
      return;
    }
    // Dropped while starting: nothing is kept.
    if (recording.current !== "starting") return void recorder.cancel();
    recording.current = next;
    setUse(next);
    if (ending.current) void finish();
  };
  const finish = async () => {
    const now = recording.current;
    if (now === "starting") ending.current = true;
    if (!now || now === "starting") return;
    recording.current = undefined;
    setUse(undefined);
    setTranscribing(targets.transcription);
    try {
      const audio = await recorder.stop();
      if (audio) await spoken(now, audio, targets, kernel);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setTranscribing(false);
    }
  };
  return {
    use,
    transcribing,
    error,
    start,
    finish,
    discard() {
      recording.current = undefined;
      setUse(undefined);
      void recorder.cancel();
    },
    /** Dictate or Record pressed: it records at once, or ends what records. */
    press(next: VoiceUse) {
      pressed.current = { at: Date.now(), recording: !!recording.current };
      if (!recording.current) void start(next);
    },
    release() {
      if (endsOnRelease(pressed.current)) void finish();
    },
  };
}

/**
 * A text said by an agent's own voice, a sentence or a few at a time: each piece is made
 * while the one before it plays. Playing is the client's.
 */
export async function* readAloud(
  actorId: string,
  text: string,
  signal?: AbortSignal,
  kernel = kernelUrl(),
) {
  const { sentences } = await voice<{ sentences: string[] }>(
    "sentences",
    { text },
    kernel,
    signal,
  );
  const say = (sentence?: string) => {
    if (!sentence) return undefined;
    const speech = voice<Speech>(
      "speak",
      { actor_id: actorId, text: sentence },
      kernel,
      signal,
    );
    // Stopped before it plays, it fails unheard.
    speech.catch(() => undefined);
    return speech;
  };
  let next = say(sentences[0]);
  for (let at = 1; next; at++) {
    const piece = await next;
    next = say(sentences[at]);
    yield piece;
  }
}

/** What an agent says to be heard: a greeting in the language its voice speaks best. */
export const voiceGreeting = (name: string, language: string) =>
  language === "it" ? `Ciao, sono ${name}.` : `Hi, I'm ${name}.`;

/** Three voices for an agent from a description of it in English, each saying a greeting. */
export const designVoice = (
  actorId: string,
  description: string,
  language?: string,
  kernel = kernelUrl(),
) =>
  voice<{ proposals: VoiceProposal[] }>(
    "design",
    { actor_id: actorId, description, ...(language ? { language } : {}) },
    kernel,
  ).then((r) => r.proposals);

/** One of the proposals becomes the agent's voice. */
export const chooseVoice = async (
  actorId: string,
  proposal: string,
  kernel = kernelUrl(),
) => {
  const { voice: chosen } = await voice<{ voice: Voice }>(
    "choose",
    { actor_id: actorId, proposal },
    kernel,
  );
  extensionsNotice();
  return chosen;
};

/** The agent goes back to having no voice. */
export const forgetVoice = async (actorId: string, kernel = kernelUrl()) => {
  await voice("forget", { actor_id: actorId }, kernel);
  extensionsNotice();
};
