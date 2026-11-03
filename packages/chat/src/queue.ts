import { useEffect } from "react";
import { kernelUrl, request } from "./client";
import { rereadShown, sharedRead, useSharedRead } from "./shared-read";

/**
 * An input sent while its session worked: ZeroLux holds it, and sends it as a turn of its own
 * when the turn before ends, in order. A Stop sends the whole queue at once.
 */
export interface QueueItem {
  id: string;
  text: string;
  /** The kinds of the images that go with it. */
  images: { media_type: string }[];
  created_at: number;
  author_id: string;
}

const path = (sessionId: string, rest = "") =>
  `/sessions/${encodeURIComponent(sessionId)}/queue${rest}`;
const item = (itemId: string) => `/${encodeURIComponent(itemId)}`;

// One reader for each kernel, for its whole life: shared reads go by the reader.
const readers = new Map<string, (sessionId: string) => Promise<QueueItem[]>>();
function readerOf(kernel: string) {
  let read = readers.get(kernel);
  if (!read) {
    read = async (sessionId) =>
      (await request<{ queue: QueueItem[] }>(kernel, path(sessionId))).queue;
    readers.set(kernel, read);
  }
  return read;
}

const none: QueueItem[] = [];

/** A session's queue, in order, read again at each of its notices. */
export function useQueue(sessionId: string, kernel = kernelUrl()) {
  const read = readerOf(kernel);
  const { read: queue } = useSharedRead(read, sessionId, true);
  useEffect(() => void sharedRead(read, sessionId, true), [read, sessionId]);
  return queue?.items ?? none;
}

/** The kernel says a session's queue changed: whoever shows it reads it again. */
export const queueNotice = (kernel: string, sessionId: string) =>
  rereadShown(readerOf(kernel), sessionId);

/** After a reconnection, every queue shown is read again. */
export const queueResync = (kernel: string) => rereadShown(readerOf(kernel));

/** Reads a session's queue again, as it is now. */
export const readQueue = (kernel: string, sessionId: string) =>
  sharedRead(readerOf(kernel), sessionId);

/** Changes a session's queue, then reads it again, so the change shows at once. */
async function change(
  kernel: string,
  sessionId: string,
  rest: string,
  body?: unknown,
  method?: "PUT" | "PATCH" | "DELETE",
) {
  await request(kernel, path(sessionId, rest), body, undefined, method);
  await readQueue(kernel, sessionId);
}

/** Rewrites an input waiting in a session's queue. */
export const editQueued = (
  kernel: string,
  sessionId: string,
  itemId: string,
  text: string,
) => change(kernel, sessionId, item(itemId), { text }, "PATCH");

/** Takes an input out of a session's queue. */
export const removeQueued = (
  kernel: string,
  sessionId: string,
  itemId: string,
) => change(kernel, sessionId, item(itemId), undefined, "DELETE");

/** Sends a waiting input now: into the turn in progress, or as a turn of its own at rest. */
export const sendQueued = (kernel: string, sessionId: string, itemId: string) =>
  change(kernel, sessionId, `${item(itemId)}/send`, {});

/** Puts a session's waiting inputs in this order. */
export const reorderQueue = (
  kernel: string,
  sessionId: string,
  ids: string[],
) => change(kernel, sessionId, "/order", { ids }, "PUT");

/** Empties a session's queue. */
export const clearQueue = (kernel: string, sessionId: string) =>
  change(kernel, sessionId, "", undefined, "DELETE");
