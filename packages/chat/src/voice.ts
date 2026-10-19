import { kernelUrl } from "./client";
import {
  extensionsNotice,
  runAction,
  useActions,
  useKernelList,
} from "./extensions";

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
