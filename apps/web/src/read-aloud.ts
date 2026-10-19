import { useEffect, useRef, useState } from "react";
import { errorMessage, readAloud } from "@zerolux/chat";

/**
 * Audio from the kernel as the page may play it: a blob URL, since its content policy allows
 * no `data:` media. Revoke it once played.
 */
export function audioUrl(audio: string, type: string) {
  const bytes = Uint8Array.from(atob(audio), (char) => char.charCodeAt(0));
  return URL.createObjectURL(new Blob([bytes], { type }));
}

/**
 * One text read aloud at a time, in its agent's voice: each piece plays as soon as it is made,
 * while the next is made. Reading another, or stopping, ends the one that plays. What went
 * wrong stays with the text it was reading, without blocking the rest of the page.
 */
export function useReadAloud() {
  const [reading, setReading] = useState<string>();
  const [failed, setFailed] = useState<{ id: string; error: string }>();
  const current = useRef<{ stop: AbortController; audio?: HTMLAudioElement }>(
    null,
  );

  function stop() {
    const playing = current.current;
    current.current = null;
    setReading(undefined);
    playing?.stop.abort();
    playing?.audio?.pause();
  }
  // Nothing goes on playing once the page leaves.
  useEffect(() => stop, []);

  /** Reads `text` in the voice of `actorId`; `id` names what is being read. */
  async function read(id: string, actorId: string, text: string) {
    stop();
    const playing = { stop: new AbortController() } as {
      stop: AbortController;
      audio?: HTMLAudioElement;
    };
    current.current = playing;
    setReading(id);
    setFailed(undefined);
    const { signal } = playing.stop;
    try {
      for await (const piece of readAloud(actorId, text, signal)) {
        if (signal.aborted) return;
        const url = audioUrl(piece.audio, piece.type);
        const audio = new Audio(url);
        playing.audio = audio;
        try {
          await new Promise<void>((resolve, reject) => {
            audio.onended = () => resolve();
            audio.onerror = () =>
              reject(new Error("The voice can't be played"));
            signal.addEventListener("abort", () => resolve(), { once: true });
            audio.play().catch(reject);
          });
        } finally {
          URL.revokeObjectURL(url);
        }
      }
    } catch (error) {
      // Stopped on purpose, a piece still being made fails: that is no error.
      if (!signal.aborted) setFailed({ id, error: errorMessage(error) });
    } finally {
      if (current.current === playing) {
        current.current = null;
        setReading(undefined);
      }
    }
  }

  return { reading, failed, read, stop };
}
