import { Image, Linking, View } from "react-native";
import { EnrichedMarkdownText } from "react-native-enriched-markdown";
import type { MarkdownStyle } from "react-native-enriched-markdown";
import { useCSSVariable } from "uniwind";
import Mermaid from "@/components/mermaid";
import { segments } from "../src/markdown";
import { useTheme } from "../src/theme";

const SAFE = /^(https?:|mailto:)/i;

/**
 * Code colors on a light page, as the web's GitHub light theme; on a dark one the library's
 * own GitHub dark colors stay.
 */
const lightCode = {
  keyword: "#cf222e",
  string: "#0a3069",
  number: "#0550ae",
  constant: "#0550ae",
  comment: "#6e7781",
  function: "#8250df",
  type: "#953800",
  property: "#0550ae",
  tag: "#116329",
  attribute: "#0550ae",
};

/**
 * Chat text as the author wrote it: Markdown with tables, code, links and lists, and Mermaid
 * diagrams drawn. Links open as http(s) or mailto. With `picture`, an image on a line of its
 * own shows from where `picture` says, as a README's own files.
 */
export function MessageBody({
  text,
  picture,
  selectable = true,
}: {
  text: string;
  picture?: (src: string) => string | undefined;
  /** Its words can be selected; not when a long press opens a menu with Copy. */
  selectable?: boolean;
}) {
  const { resolved } = useTheme();
  const [foreground, muted, link, card, border, accent, background] =
    useCSSVariable([
      "--color-foreground",
      "--color-muted-foreground",
      "--color-human-foreground",
      "--color-card",
      "--color-border",
      "--color-accent",
      "--color-background",
    ]);
  const color = (value: string | number | undefined, fallback: string) =>
    typeof value === "string" ? value : fallback;
  const ink = color(foreground, "#edece8");
  // Chivo speaks for people, Chivo Mono for code.
  const sans = "Chivo";
  const mono = "Chivo Mono";
  // Every color from the theme: the library's own are for a white page.
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
      backgroundColor: "transparent",
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
      markerColor: color(muted, "#a6a9af"),
    },
    codeBlock: {
      color: ink,
      backgroundColor: color(card, "#121417"),
      borderColor: color(border, "#1e2126"),
      fontFamily: mono,
      fontSize: 13,
      ...(resolved === "dark" ? {} : { syntaxColors: lightCode }),
    },
    code: {
      color: ink,
      fontFamily: mono,
      backgroundColor: color(accent, "#1b1e23"),
      borderColor: color(border, "#1e2126"),
    },
    underline: { color: ink },
    strikethrough: { color: color(muted, "#a6a9af") },
    thematicBreak: { color: color(border, "#1e2126") },
    math: { color: ink, backgroundColor: color(card, "#121417") },
    inlineMath: { color: ink },
    taskList: {
      checkedColor: color(link, "#ffc95c"),
      borderColor: color(muted, "#a6a9af"),
      checkmarkColor: color(background, "#0a0b0d"),
      checkedTextColor: color(muted, "#a6a9af"),
    },
    link: { color: color(link, "#ffc95c") },
    table: {
      color: ink,
      fontFamily: sans,
      fontSize: 14,
      lineHeight: 20,
      headerFontFamily: sans,
      headerTextColor: ink,
      headerBackgroundColor: color(card, "#121417"),
      rowEvenBackgroundColor: color(background, "#0a0b0d"),
      rowOddBackgroundColor: color(card, "#121417"),
      borderColor: color(border, "#1e2126"),
    },
  };
  return (
    <View>
      {segments(text, picture).map((segment, index) =>
        segment.kind === "image" ? (
          <Image
            key={index}
            source={{ uri: segment.text }}
            accessibilityLabel={segment.alt}
            resizeMode="contain"
            className="my-2 aspect-[16/10] w-full rounded-lg bg-muted"
          />
        ) : segment.kind === "mermaid" ? (
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
            selectable={selectable}
            onLinkPress={({ url }) => {
              if (SAFE.test(url)) void Linking.openURL(url);
            }}
          />
        ),
      )}
    </View>
  );
}
