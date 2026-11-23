import type { InputImage, InputMode } from "./chat";
import type { QueuedInput } from "./live";
import type { SessionBlock } from "./session-events";
import type { QueueItem } from "./queue";

/** One local row through sending, queuing and recording; its id doesn't change. */
export interface SentInput {
  id: string;
  session_id: string;
  text: string;
  images: InputImage[];
  mode: InputMode;
  after: number;
  status: "sending" | "queued" | "sent" | "failed";
  queueId?: string;
  error?: string;
}
const words = (text: string) => text.replace(/\s+/g, " ").trim();
export function unseenInputs(
  sent: SentInput[],
  sessionId: string,
  blocks: SessionBlock[],
  queue: QueuedInput[],
  from?: number,
  waiting: QueueItem[] = [],
) {
  const mine = sent.filter((i) => i.session_id === sessionId);
  const recorded = new Set<string>();
  const taken = new Set<string>();
  // In order, an exact native input accounts for one submission. A batch of queued
  // inputs is one native message, joined with blank lines by the kernel.
  for (const block of blocks) {
    if (block.kind !== "input" || block.chat) continue;
    const candidates = mine.filter(
      (i) => !recorded.has(i.id) && i.after <= block.at,
    );
    const text = words(block.text);
    const possible = (i: SentInput) =>
      words(i.text) === text || (!i.text && i.images.length > 0);
    const single = candidates.find((i) => i.status !== "failed" && possible(i));
    if (single) {
      recorded.add(single.id);
      continue;
    }
    const batch = candidates.filter(
      (i) => i.queueId && i.status !== "failed" && i.text,
    );
    let found = false;
    for (let a = 0; a < batch.length && !found; a++) {
      let joined = "";
      for (let b = a; b < batch.length; b++) {
        joined += (b > a ? " " : "") + words(batch[b]!.text);
        if (!text.startsWith(joined)) break;
        if (joined === text) {
          for (const i of batch.slice(a, b + 1)) recorded.add(i.id);
          found = true;
          break;
        }
      }
    }
    if (!found) {
      const failed = candidates.find(
        (i) => i.status === "failed" && possible(i),
      );
      if (failed) recorded.add(failed.id);
    }
  }
  return mine.flatMap((input) => {
    if (recorded.has(input.id)) return [];
    if (input.status === "failed") return [input];
    const queued = input.queueId
      ? waiting.find((q) => q.id === input.queueId)
      : queue.find(
          (q) => !taken.has(q.id) && words(q.text) === words(input.text),
        );
    if (queued) {
      taken.add(queued.id);
      return [{ ...input, text: queued.text, status: "queued" as const }];
    }
    if (
      from !== undefined &&
      input.after < from &&
      input.status === "sent" &&
      !input.queueId
    )
      return [];
    return [input];
  });
}
