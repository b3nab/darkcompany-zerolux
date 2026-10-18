import { useEffect, useState } from "react";
import { errorMessage, kernelUrl, request } from "./client";
import type { Harness } from "./client";

/**
 * A place in a session's history that matches: where in its record (`at`, as `/events`
 * names it), when, what kind of step, and the words around the match.
 */
export interface HistoryHit {
  session_id: string;
  title: string;
  harness: Harness;
  at: number;
  time: string | null;
  kind: "input" | "text" | "thinking" | "tool_call";
  snippet: string;
}

export const hitKindLabels: Record<HistoryHit["kind"], string> = {
  input: "Input",
  text: "Answer",
  thinking: "Reasoning",
  tool_call: "Tool call",
};

/** A match's text in parts, the words searched marked, whatever their case. */
export function matchParts(text: string, query: string) {
  const words = query.trim().split(/\s+/).filter(Boolean);
  if (!words.length) return [{ text, match: false }];
  const pattern = new RegExp(
    `(${words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})`,
    "gi",
  );
  // Splitting on a group keeps what matched at the odd places.
  return text
    .split(pattern)
    .map((part, i) => ({ text: part, match: i % 2 === 1 }))
    .filter((part) => part.text);
}

/**
 * What the sessions one may read said and did that contains the text, the latest first: up to
 * `limit` in all, 20 per session. `truncated` when the search stopped at its time limit.
 */
export const searchHistory = (
  query: string,
  limit = 50,
  kernel = kernelUrl(),
  signal?: AbortSignal,
) =>
  request<{ results: HistoryHit[]; truncated: boolean }>(
    kernel,
    `/sessions/search?q=${encodeURIComponent(query)}&limit=${limit}`,
    undefined,
    signal,
  );

/** The history matching what is typed, read after a pause in typing; two letters at least. */
export function useHistorySearch(query: string, kernel = kernelUrl()) {
  const text = query.trim();
  const [found, setFound] = useState<{
    text: string;
    results?: HistoryHit[];
    truncated?: boolean;
    error?: string;
  }>();
  useEffect(() => {
    if (text.length < 2) return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      searchHistory(text, 50, kernel, controller.signal).then(
        ({ results, truncated }) => setFound({ text, results, truncated }),
        (error: unknown) => {
          if (!controller.signal.aborted)
            setFound({ text, error: errorMessage(error) });
        },
      );
    }, 300);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [text, kernel]);
  const current = found?.text === text ? found : undefined;
  return {
    results: current?.results,
    truncated: current?.truncated ?? false,
    error: current?.error ?? "",
    searching: text.length >= 2 && !current,
  };
}
