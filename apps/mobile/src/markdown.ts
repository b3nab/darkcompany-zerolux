export type Segment = { kind: "markdown" | "mermaid"; text: string };

const MERMAID =
  /^(?: {0,3})(`{3,}|~{3,}) *mermaid[^\n]*\n([\s\S]*?)\n(?: {0,3})\1[ \t]*$/gim;
const IMAGE = /!\[([^\]]*)\]\([^)]*\)/g;
const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const INLINE_CODE = /(`+)[\s\S]*?[^`]\1(?!`)/g;

/**
 * Chat text as the author wrote it: Markdown with tables, code, links and lists, and Mermaid
 * diagrams drawn. An image becomes its alt text; code stays exactly as written.
 */
export function segments(text: string): Segment[] {
  const result: Segment[] = [];
  let last = 0;
  for (const match of text.matchAll(MERMAID)) {
    const start = match.index ?? 0;
    if (start > last)
      result.push({ kind: "markdown", text: prose(text.slice(last, start)) });
    result.push({ kind: "mermaid", text: match[2] ?? "" });
    last = start + match[0].length;
  }
  if (last < text.length)
    result.push({ kind: "markdown", text: prose(text.slice(last)) });
  return result.filter((s) => s.text.trim() !== "");
}

/**
 * The prose of Markdown, outside fenced and inline code: images become their alt text, and
 * `||`, which the renderer always reads as a spoiler that hides text, stays two bars, as a
 * person or an agent means it ("a || b"). Table rows keep theirs: there they divide cells.
 */
function prose(text: string) {
  let fence: string | undefined;
  return text
    .split("\n")
    .map((line) => {
      const marker = FENCE.exec(line)?.[1];
      if (fence) {
        if (marker?.[0] === fence[0] && marker.length >= fence.length)
          fence = undefined;
        return line;
      }
      if (marker) {
        fence = marker;
        return line;
      }
      const row = line.trimStart().startsWith("|");
      let out = "";
      let last = 0;
      for (const code of line.matchAll(INLINE_CODE)) {
        out += words(line.slice(last, code.index), row) + code[0];
        last = (code.index ?? 0) + code[0].length;
      }
      return out + words(line.slice(last), row);
    })
    .join("\n");
}

const words = (text: string, row: boolean) => {
  const shown = text.replace(
    IMAGE,
    (_, alt: string) => `[image: ${alt || "image"}]`,
  );
  return row ? shown : shown.replaceAll("||", "\\|\\|");
};
