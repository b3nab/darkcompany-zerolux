import {
  Component,
  memo,
  useEffect,
  useMemo,
  useSyncExternalStore,
} from "react";
import type { ReactNode } from "react";
import remarkBreaks from "remark-breaks";
import {
  Streamdown,
  defaultComponents,
  defaultRehypePlugins,
  defaultRemarkPlugins,
} from "streamdown";
import type { PluginConfig, StreamdownProps } from "streamdown";
import codeRenderer from "../../generated/renderer/code.js" with { type: "file" };
import mermaidRenderer from "../../generated/renderer/mermaid.js" with { type: "file" };
import { localImage, localPath } from "@zerolux/chat";
import { LocalFile, Thumbnails } from "@/components/local-files";
import { useTheme } from "../theme";

// A chat keeps the line breaks people type; a document's are Markdown's.
const documentRemark = Object.values(defaultRemarkPlugins);
const chatRemark = [...documentRemark, remarkBreaks];
const [harden] = defaultRehypePlugins.harden as [unknown, unknown];
type Hast = {
  type?: string;
  value?: string;
  tagName?: string;
  properties?: Record<string, unknown>;
  children?: Hast[];
};
/** A document's images by their path in it, as `./media/…`: harden keeps only those as paths. */
const relativeImages = () => (tree: Hast) => {
  const walk = (node: Hast) => {
    const src = node.tagName === "img" ? node.properties?.src : undefined;
    if (typeof src === "string" && !/^([a-z][a-z\d+.-]*:|[./])/i.test(src))
      node.properties!.src = `./${src}`;
    node.children?.forEach(walk);
  };
  walk(tree);
};
/** Where a file named on the agent's computer is kept, past the link rules: by its path. */
const LOCAL = "#local:";
/**
 * A message's links and images to files on its computer, as `[shot](/tmp/x.png)` or
 * `![](~/x.png)`: kept by their path for a chip, never a link the page follows.
 */
const localFiles = () => (tree: Hast) => {
  const walk = (node: Hast) => {
    const url =
      node.tagName === "a"
        ? node.properties?.href
        : node.tagName === "img"
          ? node.properties?.src
          : undefined;
    const path = typeof url === "string" ? localPath(url) : undefined;
    if (path !== undefined) {
      if (node.tagName === "img") {
        const alt = node.properties?.alt;
        node.tagName = "a";
        node.children = [
          {
            type: "text",
            value: typeof alt === "string" && alt ? alt : path,
          },
        ];
      }
      node.properties = { href: LOCAL + encodeURIComponent(path) };
    }
    node.children?.forEach(walk);
  };
  walk(tree);
};
const pathOf = (href: string) => decodeURIComponent(href.slice(LOCAL.length));
/** The images on its computer that a paragraph or a list item's own lines name. */
const imagesOf = (node: Hast | undefined): string[] =>
  (node?.children ?? []).flatMap((child) => {
    const href = child.tagName === "a" ? child.properties?.href : undefined;
    if (typeof href === "string" && href.startsWith(LOCAL))
      return localImage(pathOf(href)) ? [pathOf(href)] : [];
    // A paragraph or a list inside shows its own.
    return ["p", "ul", "ol"].includes(child.tagName ?? "")
      ? []
      : imagesOf(child);
  });
/**
 * Links as Streamdown draws them, a file on the agent's computer as a chip; the images a
 * paragraph or a list item names, small, under its text.
 */
const messageComponents: StreamdownProps["components"] = {
  a: (props) =>
    props.href?.startsWith(LOCAL) ? (
      <LocalFile path={pathOf(props.href)}>{props.children}</LocalFile>
    ) : (
      <defaultComponents.a {...props} />
    ),
  p: (props) => (
    <>
      <defaultComponents.p {...props} />
      <Thumbnails paths={imagesOf(props.node as Hast | undefined)} />
    </>
  ),
  li: ({ children, ...props }) => (
    <defaultComponents.li {...props}>
      {children}
      <Thumbnails paths={imagesOf(props.node as Hast | undefined)} />
    </defaultComponents.li>
  ),
};
/**
 * Raw HTML shows as text; links only to the web or mail, a message's files on its computer as
 * chips; in a document only the images its `image` finds.
 */
const rehype = (images: boolean) =>
  [
    images ? relativeImages : localFiles,
    defaultRehypePlugins.sanitize,
    [
      harden,
      {
        allowedLinkPrefixes: ["*"],
        allowedProtocols: ["http", "https", "mailto"],
        allowedImagePrefixes: images ? ["*"] : [],
        allowDataImages: false,
      },
    ],
  ] as StreamdownProps["rehypePlugins"];
const chatRehype = rehype(false);
const documentRehype = rehype(true);

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

/** A document beside the chat, as a README: it draws the images it shows, by their address in it. */
export interface MarkdownDocument {
  image: (src: string, alt: string) => ReactNode;
}

/** A message's text as Markdown: tables, links, code and Mermaid diagrams. */
export const MessageText = memo(function MessageText({
  text,
  document,
}: {
  text: string;
  /** It is a document, not a message. */
  document?: MarkdownDocument;
}) {
  const loaded = useSyncExternalStore(
    subscribe,
    () => plugins,
    () => plugins,
  );
  const { resolved } = useTheme();
  // A document draws its images; a message, the files its agent names.
  const components = useMemo<StreamdownProps["components"]>(
    () =>
      document
        ? {
            img: ({ src, alt }) =>
              typeof src === "string"
                ? document.image(
                    decodeURI(src.replace(/^\.?\//, "")),
                    alt ?? "",
                  )
                : null,
          }
        : messageComponents,
    [document],
  );
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
        remarkPlugins={document ? documentRemark : chatRemark}
        rehypePlugins={document ? documentRehype : chatRehype}
        components={components}
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
