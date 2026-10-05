import { Component, memo, useEffect, useSyncExternalStore } from "react";
import type { ReactNode } from "react";
import remarkBreaks from "remark-breaks";
import {
  Streamdown,
  defaultRehypePlugins,
  defaultRemarkPlugins,
} from "streamdown";
import type { PluginConfig, StreamdownProps } from "streamdown";
import codeRenderer from "../../generated/renderer/code.js" with { type: "file" };
import mermaidRenderer from "../../generated/renderer/mermaid.js" with { type: "file" };
import { useTheme } from "../theme";

// A chat keeps the line breaks people type.
const remarkPlugins = [...Object.values(defaultRemarkPlugins), remarkBreaks];
const [harden] = defaultRehypePlugins.harden as [unknown, unknown];
/** Raw HTML shows as text; links only to the web or mail; no images. */
const rehypePlugins = [
  defaultRehypePlugins.sanitize,
  [
    harden,
    {
      allowedLinkPrefixes: ["*"],
      allowedProtocols: ["http", "https", "mailto"],
      allowedImagePrefixes: [],
      allowDataImages: false,
    },
  ],
] as StreamdownProps["rehypePlugins"];

// Real links, opened in a new tab: no confirmation dialog in front of them.
const directLinks = { enabled: false };

type Lazy = Pick<PluginConfig, "code" | "mermaid">;
/** Diagrams come in two, one per theme. */
type Loaded = Lazy & { mermaidLight?: PluginConfig["mermaid"] };
/** The plugins loaded so far, shared by every message: one load renders them all. */
let plugins: Loaded = {};
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => void listeners.delete(listener);
};
const loading = new Set<keyof Lazy>();
// After a failed load: 2 s, 5 s, 15 s, 30 s, then every minute.
const RETRY = [2_000, 5_000, 15_000, 30_000, 60_000];
// Fenced blocks wherever they are (in a quote, in a list): backticks or tildes. A fence
// that is not one at worst loads a plugin early.
const fence = /`{3,}|~{3,}/;
const mermaidFence = /(?:`{3,}|~{3,})[ \t]*mermaid\b/i;
/** The plugins a message needs: highlighting for any fenced block, diagrams for Mermaid. */
export const pluginsFor = (text: string): (keyof Lazy)[] => [
  ...(fence.test(text) ? (["code"] as const) : []),
  ...(mermaidFence.test(text) ? (["mermaid"] as const) : []),
];

const renderer = { code: codeRenderer, mermaid: mermaidRenderer };

/**
 * Loads highlighting or diagrams, each one self-contained file. A failed load is retried at a
 * new address, since Chrome never refetches a module that failed in the same page.
 */
function load(name: keyof Lazy, attempt = 0) {
  if (plugins[name] || loading.has(name)) return;
  loading.add(name);
  const url = attempt ? `${renderer[name]}?attempt=${attempt}` : renderer[name];
  (import(url) as Promise<Loaded>).then(
    (loaded) => {
      loading.delete(name);
      plugins = { ...plugins, ...loaded };
      for (const listener of listeners) listener();
    },
    // Loading until the retry: a message that needs it meanwhile waits for that one.
    () =>
      setTimeout(
        () => {
          loading.delete(name);
          load(name, attempt + 1);
        },
        RETRY[Math.min(attempt, RETRY.length - 1)],
      ),
  );
}

/** Loads highlighting and diagrams after start-up, while ZeroLux is reachable. */
export function preloadRenderer() {
  load("code");
  load("mermaid");
}

/** A message that fails to render shows its plain text instead. */
class Contained extends Component<
  { text: string; children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    return this.state.failed ? (
      <p className="text-sm break-words whitespace-pre-wrap">
        {this.props.text}
      </p>
    ) : (
      this.props.children
    );
  }
}

/** A message's text as Markdown: tables, links, code and Mermaid diagrams. */
export const MessageText = memo(function MessageText({
  text,
}: {
  text: string;
}) {
  const loaded = useSyncExternalStore(
    subscribe,
    () => plugins,
    () => plugins,
  );
  const { resolved } = useTheme();
  const needs = pluginsFor(text).join();
  useEffect(() => {
    for (const name of pluginsFor(text)) load(name);
    // Only which plugins the text needs matters, not every edit of it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [needs]);
  return (
    // Tried again once more of the renderer has loaded.
    <Contained key={Object.keys(loaded).join()} text={text}>
      <Streamdown
        mode="static"
        remarkPlugins={remarkPlugins}
        rehypePlugins={rehypePlugins}
        plugins={{
          code: loaded.code,
          mermaid: resolved === "light" ? loaded.mermaidLight : loaded.mermaid,
        }}
        linkSafety={directLinks}
        className="space-y-2 text-sm break-words [&_[data-streamdown=inline-code]]:bg-background/60 [&>*:first-child]:mt-0 [&>*:last-child]:mb-0"
      >
        {text}
      </Streamdown>
    </Contained>
  );
});
