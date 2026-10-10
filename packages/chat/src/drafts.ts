/**
 * What you typed in each chat and have not sent yet: it waits there while you are elsewhere,
 * as in a messaging app. A client can also keep it across restarts with `keepDraftsIn`.
 */
const drafts = new Map<string, string>();

/** A copy of this client's unsent text, including changes storage could not persist. */
export const currentDrafts = (): Record<string, string> =>
  Object.fromEntries(drafts);
let save: ((all: Record<string, string>) => void) | undefined;

/** Starts from the drafts a client saved, and saves every change through `store`. */
export function keepDraftsIn(
  saved: Record<string, unknown>,
  store: (all: Record<string, string>) => void,
) {
  for (const [id, text] of Object.entries(saved))
    if (typeof text === "string" && text) drafts.set(id, text);
  save = store;
}

/** The unsent text of a chat. */
export const draftOf = (conversationId: string) =>
  drafts.get(conversationId) ?? "";

/** Keeps the unsent text of a chat; an empty one is forgotten. */
export function saveDraft(conversationId: string, text: string) {
  if (text === draftOf(conversationId)) return;
  if (text) drafts.set(conversationId, text);
  else drafts.delete(conversationId);
  save?.(Object.fromEntries(drafts));
}
