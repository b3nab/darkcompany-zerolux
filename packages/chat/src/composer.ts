import type { VoiceUse } from "./voice";

/** What the composer's one filled button does now. */
export type ComposerAction =
  | "record"
  | "send"
  | "interrupt"
  | "write"
  | "transcribing";

/**
 * The composer's one filled button, always in the same corner: Record while the box is
 * empty, Send once it holds something, Interrupt while the agent works and nothing is
 * written. While the microphone records, it ends the recording: dictation is written in the
 * box, a message is sent.
 */
export function composerAction({
  filled,
  interruptible,
  recordable,
  voice,
  transcribing,
}: {
  /** Words or attachments wait in the box. */
  filled: boolean;
  /** The agent works and can be stopped from here. */
  interruptible: boolean;
  /** Record works here: the workspace transcribes, or keeps the recording. */
  recordable: boolean;
  /** What the microphone records for now. */
  voice?: VoiceUse;
  transcribing: boolean;
}): ComposerAction {
  if (transcribing) return "transcribing";
  if (voice) return voice === "dictation" ? "write" : "send";
  if (filled) return "send";
  if (interruptible) return "interrupt";
  return recordable ? "record" : "send";
}
