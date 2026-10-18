import { useEffect, useState } from "react";
import { kernelUrl, request } from "./client";

/** The "@" word being written under the cursor: what follows "@" so far, and where the word lies. */
export interface Mention {
  query: string;
  start: number;
  end: number;
}

/**
 * The file mention being written at the cursor, if any: a word that starts with "@" after a
 * space or at the start, so an address like name@host is not one.
 */
export function mentionAt(text: string, cursor: number): Mention | undefined {
  const typed = /(?:^|\s)@([^\s@]*)$/.exec(text.slice(0, cursor));
  if (!typed) return undefined;
  const rest = /^\S*/.exec(text.slice(cursor))![0];
  return {
    query: typed[1]!,
    start: cursor - typed[1]!.length - 1,
    end: cursor + rest.length,
  };
}

/** The text with the mention replaced by the file's path, and where the cursor goes after it. */
export function withMention(text: string, mention: Mention, path: string) {
  const after = text.slice(mention.end);
  // One space after the path: the one already there, or a new one.
  const spaced = /^\s/.test(after);
  const inserted = `@${path}${spaced ? "" : " "}`;
  return {
    text: text.slice(0, mention.start) + inserted + after,
    cursor: mention.start + inserted.length + (spaced ? 1 : 0),
  };
}

/** How many files the menu offers at a time. */
const LIMIT = 20;

/**
 * The files in a session's folder that match what follows "@", as the kernel finds them:
 * names that match first, then the shortest paths. While a new query is read, the last
 * answer for the same session stays; none without a query.
 */
export function useSessionFiles(
  sessionId: string,
  query: string | undefined,
  kernel = kernelUrl(),
): string[] {
  const [found, setFound] = useState<{ session: string; files: string[] }>();
  const session = `${kernel}\n${sessionId}`;
  useEffect(() => {
    if (query === undefined) return;
    const controller = new AbortController();
    // A pause in typing reads; each key alone does not.
    const timer = setTimeout(() => {
      void request<{ files: string[] }>(
        kernel,
        `/sessions/${encodeURIComponent(sessionId)}/files?query=${encodeURIComponent(query)}&limit=${LIMIT}`,
        undefined,
        controller.signal,
      ).then(
        ({ files }) => setFound({ session, files }),
        // Without an answer the menu shows what it had.
        () => undefined,
      );
    }, 120);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [kernel, sessionId, query, session]);
  return query !== undefined && found?.session === session ? found.files : [];
}
