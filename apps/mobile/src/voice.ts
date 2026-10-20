import { useSyncExternalStore } from "react";
import { Alert } from "react-native";
import {
  createAudioPlayer,
  RecordingPresets,
  requestRecordingPermissionsAsync,
  setAudioModeAsync,
  useAudioRecorder,
  useAudioRecorderState,
} from "expo-audio";
import type { AudioPlayer } from "expo-audio";
import { File as Saved, Paths } from "expo-file-system";
import { errorMessage, readAloud } from "@zerolux/chat";
import type { Recorder } from "@zerolux/chat";

/** A file on this phone as the `File` the kernel's storage takes. */
export async function asFile(uri: string, name: string, type?: string) {
  const blob = await (await fetch(uri)).blob();
  return new File([blob], name, { type: type ?? blob.type });
}

/** Records from the microphone: one recording at a time, kept until stopped or dropped. */
export function useRecorder(): Recorder & { seconds: number } {
  const recorder = useAudioRecorder(RecordingPresets.HIGH_QUALITY);
  const state = useAudioRecorderState(recorder, 250);
  const release = () => setAudioModeAsync({ allowsRecording: false });
  return {
    seconds: Math.floor(state.durationMillis / 1000),
    async start() {
      if (!(await requestRecordingPermissionsAsync()).granted)
        throw new Error("allow it for ZeroLux in Settings");
      await setAudioModeAsync({
        playsInSilentMode: true,
        allowsRecording: true,
      });
      await recorder.prepareToRecordAsync();
      recorder.record();
    },
    /** Ends the recording and gives its audio. */
    async stop() {
      await recorder.stop();
      await release();
      return recorder.uri ? (await fetch(recorder.uri)).blob() : undefined;
    },
    /** Drops the recording. */
    async cancel() {
      if (state.isRecording) await recorder.stop();
      await release();
    },
  };
}

/** A piece of speech, its audio in base64. */
type Piece = { audio: string; type: string };

// One thing plays at a time in the whole app: a new one stops the one before.
let player: AudioPlayer | undefined;
let playing: { id: string; stop: AbortController } | undefined;
const listeners = new Set<() => void>();
const changed = () => listeners.forEach((listener) => listener());
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

/** What plays now, by the ID it was played with. */
export const usePlaying = () =>
  useSyncExternalStore(subscribe, () => playing?.id);

export function stopPlaying() {
  playing?.stop.abort();
  player?.pause();
  playing = undefined;
  changed();
}

/** Plays a piece to its end, or until stopped. */
async function played(piece: Piece, at: number, signal: AbortSignal) {
  const file = new Saved(
    Paths.cache,
    `speech-${Date.now()}-${at}.${piece.type === "audio/wav" ? "wav" : "audio"}`,
  );
  file.create({ overwrite: true });
  await file.write(piece.audio, { encoding: "base64" });
  player ??= createAudioPlayer();
  const sound = player;
  return new Promise<void>((resolve) => {
    const done = () => {
      update.remove();
      signal.removeEventListener("abort", done);
      file.delete();
      resolve();
    };
    const update = sound.addListener(
      "playbackStatusUpdate",
      (status) => status.didJustFinish && done(),
    );
    signal.addEventListener("abort", done);
    sound.replace({ uri: file.uri });
    sound.play();
  });
}

/** Plays pieces of speech one after another as they come; the same ID again stops them. */
export async function play(
  id: string,
  pieces: (signal: AbortSignal) => AsyncIterable<Piece> | Piece[],
) {
  const again = playing?.id === id;
  stopPlaying();
  if (again) return;
  const stop = new AbortController();
  playing = { id, stop };
  changed();
  try {
    await setAudioModeAsync({ playsInSilentMode: true });
    let at = 0;
    for await (const piece of pieces(stop.signal)) {
      if (stop.signal.aborted) break;
      await played(piece, at++, stop.signal);
    }
  } catch (e) {
    if (!stop.signal.aborted)
      Alert.alert("It can't be played", errorMessage(e));
  } finally {
    if (playing?.stop === stop) {
      playing = undefined;
      changed();
    }
  }
}

/** An agent's text read aloud with its own voice. */
export const readText = (id: string, actorId: string, text: string) =>
  play(id, (signal) => readAloud(actorId, text, signal));
