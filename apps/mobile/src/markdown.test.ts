import { expect, test } from "bun:test";
import { segments } from "./markdown";

const markdown = (text: string) =>
  segments(text)
    .map((s) => s.text)
    .join("|");

test("two bars stay two bars outside code and tables, never a hidden spoiler", () => {
  expect(markdown("Run a || b || c")).toBe("Run a \\|\\| b \\|\\| c");
  expect(markdown("Use `a || b` here")).toBe("Use `a || b` here");
  expect(markdown("```sh\nfalse || true\n```")).toBe(
    "```sh\nfalse || true\n```",
  );
  expect(markdown("| a || b |\n|---|---|---|")).toBe(
    "| a || b |\n|---|---|---|",
  );
});

test("an image becomes its alt text, except in code", () => {
  expect(markdown("See ![chart](x.png)")).toBe("See [image: chart]");
  expect(markdown("`![x](y)`")).toBe("`![x](y)`");
});

test("a Mermaid diagram is its own segment", () => {
  expect(segments("Before\n```mermaid\ngraph TD; A-->B\n```\nAfter")).toEqual([
    { kind: "markdown", text: "Before\n" },
    { kind: "mermaid", text: "graph TD; A-->B" },
    { kind: "markdown", text: "\nAfter" },
  ]);
});

test("an image on its own line shows where the reader says, and only there", () => {
  const picture = (src: string) =>
    src === "media/a.png" ? "http://192.0.2.4/a" : undefined;
  expect(
    segments(
      "Intro\n\n![The board](media/a.png)\n\nMore ![b](media/a.png) and\n![c](x.png)",
      picture,
    ),
  ).toEqual([
    { kind: "markdown", text: "Intro\n" },
    { kind: "image", text: "http://192.0.2.4/a", alt: "The board" },
    {
      kind: "markdown",
      text: "\nMore [image: b] and\n[image: c]",
    },
  ]);
  // In code it stays as written; without a reader every image is its alt text.
  expect(segments("```\n![a](media/a.png)\n```", picture)).toEqual([
    { kind: "markdown", text: "```\n![a](media/a.png)\n```" },
  ]);
  expect(markdown("![a](media/a.png)")).toBe("[image: a]");
});
