import { kernelUrl, request } from "./client";

// TODO: kernel: speech to text on the kernel's machine, announced as the "transcription-v1"
// capability. `POST /transcriptions` takes recorded audio as the body and answers `{ text }`.

/** What was said in a recording, as text, transcribed by the kernel. */
export const transcribe = (audio: Blob, kernel = kernelUrl()) =>
  request<{ text: string }>(kernel, "/transcriptions", audio).then(
    (r) => r.text,
  );
