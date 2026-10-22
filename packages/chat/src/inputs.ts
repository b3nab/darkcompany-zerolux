import type { InputImage, InputMode } from "./chat";
import type { QueuedInput } from "./live";
import type { SessionBlock } from "./session-events";

/**
 * The owner's input to a session as it travels: shown at the end of the session until its
 * record or its queue has it. A failed one stays, with its error, to send again.
 */
export interface SentInput {
  id: string;
  session_id: string;
  text: string;
  images: InputImage[];
  mode: InputMode;
  /** Where the session's native record ended when it was sent: the input comes after. */
  after: number;
  status: "sending" | "sent" | "failed";
  error?: string;
}

const words = (text: string) => text.replace(/\s+/g, " ").trim();

/**
 * The inputs sent to a session that neither its record, from where each was sent, nor its
 * queue show yet, in order. Each input of the record or the queue answers one sent input:
 * those on their way first, then failed ones, which go too once the record shows they arrived
 * after all, as when the harness took one after reporting it lost. With `from`, where the
 * events read start, one sent before it that they do not show was recorded before it: read
 * from its end again, a record shows only its latest work.
 */
export function unseenInputs(
  sent: SentInput[],
  sessionId: string,
  blocks: SessionBlock[],
  queue: QueuedInput[],
  from?: number,
) {
  const recorded = new Set<string>();
  const queued = new Set<string>();
  const inRecord = (input: SentInput) => {
    const text = words(input.text);
    const block = blocks.find(
      (b) =>
        b.kind === "input" &&
        b.at >= input.after &&
        !recorded.has(b.key) &&
        // Images alone: the first input after it.
        (!text || words(b.text) === text),
    );
    if (block) recorded.add(block.key);
    return !!block;
  };
  const mine = sent.filter((input) => input.session_id === sessionId);
  const unseen = mine.filter((input) => {
    if (input.status === "failed") return true;
    if (inRecord(input)) return false;
    const text = words(input.text);
    const item = queue.find((q) => !queued.has(q.id) && words(q.text) === text);
    if (item) queued.add(item.id);
    return !item && (from === undefined || input.after >= from);
  });
  return unseen.filter(
    (input) => input.status !== "failed" || !inRecord(input),
  );
}
