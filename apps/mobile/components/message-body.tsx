import { Linking, View } from "react-native";
import { EnrichedMarkdownText } from "react-native-enriched-markdown";
import type { MarkdownStyle } from "react-native-enriched-markdown";
import { useCSSVariable } from "uniwind";
import Mermaid from "@/components/mermaid";
import { useTheme } from "../src/theme";

type Segment = { kind: "markdown" | "mermaid"; text: string };

const MERMAID =
  /^(?: {0,3})(`{3,}|~{3,}) *mermaid[^\n]*\n([\s\S]*?)\n(?: {0,3})\1[ \t]*$/gim;
const IMAGE = /!\[([^\]]*)\]\([^)]*\)/g;

/**
 * Chat text as the author wrote it: Markdown with tables, code, links and lists, and Mermaid
 * diagrams drawn. An image becomes its alt text; links open as http(s) or mailto.
 */
export function segments(text: string): Segment[] {
  const result: Segment[] = [];
  let last = 0;
  for (const match of text.matchAll(MERMAID)) {
    const start = match.index ?? 0;
    if (start > last)
      result.push({ kind: "markdown", text: text.slice(last, start) });
    result.push({ kind: "mermaid", text: match[2] });
    last = start + match[0].length;
  }
  if (last < text.length)
    result.push({ kind: "markdown", text: text.slice(last) });
  return result
    .map((s) =>
      s.kind === "markdown"
        ? {
            ...s,
            text: s.text.replace(
              IMAGE,
              (_, alt: string) => `[image: ${alt || "image"}]`,
            ),
          }
        : s,
    )
    .filter((s) => s.text.trim() !== "");
}

const SAFE = /^(https?:|mailto:)/i;

export function MessageBody({ text }: { text: string }) {
  const { resolved } = useTheme();
  const [foreground, muted, link, card, border, accent] = useCSSVariable([
    "--color-foreground",
    "--color-muted-foreground",
    "--color-human-foreground",
    "--color-card",
    "--color-border",
    "--color-accent",
  ]);
  const color = (value: string | number | undefined, fallback: string) =>
    typeof value === "string" ? value : fallback;
  const ink = color(foreground, "#edece8");
  // Chivo speaks for people, Chivo Mono for code.
  const sans = "Chivo";
  const mono = "Chivo Mono";
  const style: MarkdownStyle = {
    paragraph: {
      color: ink,
      fontFamily: sans,
      fontSize: 16,
      lineHeight: 22,
      marginTop: 0,
      marginBottom: 6,
    },
    h1: {
      color: ink,
      fontSize: 22,
      fontFamily: sans,
      fontWeight: "600",
      marginTop: 8,
      marginBottom: 6,
    },
    h2: {
      color: ink,
      fontSize: 20,
      fontFamily: sans,
      fontWeight: "600",
      marginTop: 8,
      marginBottom: 6,
    },
    h3: {
      color: ink,
      fontSize: 18,
      fontFamily: sans,
      fontWeight: "600",
      marginTop: 6,
      marginBottom: 4,
    },
    h4: { color: ink, fontFamily: sans, fontSize: 16, fontWeight: "600" },
    h5: { color: ink, fontFamily: sans, fontSize: 16, fontWeight: "600" },
    h6: { color: ink, fontFamily: sans, fontSize: 16, fontWeight: "600" },
    blockquote: {
      color: color(muted, "#a6a9af"),
      borderColor: color(border, "#1e2126"),
      fontFamily: sans,
      fontSize: 16,
      lineHeight: 22,
    },
    list: {
      color: ink,
      fontFamily: sans,
      fontSize: 16,
      lineHeight: 22,
      bulletColor: color(muted, "#a6a9af"),
    },
    codeBlock: {
      color: ink,
      backgroundColor: color(card, "#121417"),
      borderColor: color(border, "#1e2126"),
      fontFamily: mono,
      fontSize: 13,
    },
    code: {
      color: ink,
      fontFamily: mono,
      backgroundColor: color(accent, "#1b1e23"),
    },
    link: { color: color(link, "#ffc95c") },
    table: {
      borderColor: color(border, "#1e2126"),
      headerBackgroundColor: color(card, "#121417"),
    },
  };
  return (
    <View>
      {segments(text).map((segment, index) =>
        segment.kind === "mermaid" ? (
          <Mermaid
            key={index}
            code={segment.text}
            dark={resolved === "dark"}
            dom={{ matchContents: true }}
          />
        ) : (
          <EnrichedMarkdownText
            key={index}
            markdown={segment.text}
            flavor="github"
            markdownStyle={style}
            selectable
            onLinkPress={({ url }) => {
              if (SAFE.test(url)) void Linking.openURL(url);
            }}
          />
        ),
      )}
    </View>
  );
}
