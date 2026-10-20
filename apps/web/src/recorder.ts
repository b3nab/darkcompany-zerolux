import { useEffect, useRef, useState } from "react";

/** Whether this page may record: a browser with a microphone API, on a secure origin. */
export const canRecord = () =>
  typeof MediaRecorder !== "undefined" &&
  !!globalThis.navigator?.mediaDevices?.getUserMedia;

/** Records from the microphone: one recording at a time, kept until stopped or dropped. */
export function useRecorder() {
  const current = useRef<{
    recorder: MediaRecorder;
    chunks: Blob[];
    context: AudioContext;
    analyser: AnalyserNode;
  }>(null);
  const [since, setSince] = useState<number>();
  const [now, setNow] = useState(0);
  useEffect(() => {
    if (since === undefined) return;
    const timer = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(timer);
  }, [since]);
  // The microphone is released when the page leaves the chat.
  useEffect(() => () => end(), []);

  function end() {
    const recording = current.current;
    current.current = null;
    setSince(undefined);
    if (!recording) return;
    if (recording.recorder.state !== "inactive") recording.recorder.stop();
    for (const track of recording.recorder.stream.getTracks()) track.stop();
    void recording.context.close();
  }

  return {
    recording: since !== undefined,
    seconds:
      since === undefined ? 0 : Math.max(0, Math.floor((now - since) / 1000)),
    async start() {
      if (!canRecord()) throw new Error("this page has no access to it");
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const recorder = new MediaRecorder(stream);
      const chunks: Blob[] = [];
      recorder.ondataavailable = (e) => chunks.push(e.data);
      recorder.start();
      // What it hears, to draw: the stream's level, read as it goes.
      const context = new AudioContext();
      const analyser = context.createAnalyser();
      analyser.fftSize = 1024;
      context.createMediaStreamSource(stream).connect(analyser);
      current.current = { recorder, chunks, context, analyser };
      setSince(Date.now());
      setNow(Date.now());
    },
    /** Ends the recording and gives its audio. */
    stop() {
      const recording = current.current;
      if (!recording) return Promise.resolve(undefined);
      const done = new Promise<Blob>((resolve) => {
        recording.recorder.onstop = () =>
          resolve(
            new Blob(recording.chunks, { type: recording.recorder.mimeType }),
          );
      });
      end();
      return done;
    },
    /** Drops the recording. */
    cancel: end,
    /** How loud the microphone hears now, in dBFS: -160 in silence or when not recording. */
    level() {
      const analyser = current.current?.analyser;
      if (!analyser) return -160;
      const samples = new Float32Array(analyser.fftSize);
      analyser.getFloatTimeDomainData(samples);
      const rms = Math.sqrt(
        samples.reduce((sum, sample) => sum + sample * sample, 0) /
          samples.length,
      );
      return rms > 0 ? 20 * Math.log10(rms) : -160;
    },
  };
}
