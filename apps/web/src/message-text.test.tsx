import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { MessageText, pluginsFor } from "./components/message-text";

const render = (text: string) =>
  renderToStaticMarkup(<MessageText text={text} />);

test("messages render Markdown: tables, code, diagrams and the line breaks people type", () => {
  const table = render("| agent | state |\n|---|---|\n| maple | working |");
  expect(table).toMatch(/<table[^>]*>/);
  expect(table).toMatch(/<td[^>]*>maple<\/td>/);
  expect(render("**done** and `bun test`")).toMatch(
    /data-streamdown="strong">done<\/span>[\s\S]*<code[^>]*>bun test<\/code>/,
  );
  expect(render("```ts\nconst a = 1\n```")).toContain('data-language="ts"');
  expect(render("```mermaid\ngraph TD; A-->B\n```")).toContain(
    'data-language="mermaid"',
  );
  expect(render("line one\nline two")).toMatch(/line one<br\/>\s*line two/);
});

test("links open the web in a new tab; anything else is blocked", () => {
  const html = render(
    "[docs](https://example.com) <https://zerolux.dev> [mail](mailto:owner@example.com) [bad](javascript:alert(1)) [file](file:///etc/passwd)",
  );
  expect(html).toMatch(
    /<a[^>]*href="https:\/\/example.com\/"[^>]*rel="noopener noreferrer"[^>]*target="_blank"[^>]*>docs<\/a>/,
  );
  expect(html).toMatch(/<a[^>]*href="https:\/\/zerolux.dev\/"/);
  expect(html).toMatch(/<a[^>]*href="mailto:owner@example.com"/);
  expect(html).not.toContain("javascript:");
  expect(html).not.toContain("file:");
  expect(html).toContain("bad [blocked]");
});

test("a message never runs HTML nor loads images from elsewhere", () => {
  const html = render(
    'Can you <b>check</b> <script>alert(1)</script> <img src="https://t.example/p.png"> the test? ![x](https://t.example/p.png) ![d](data:image/png;base64,AAAA)',
  );
  expect(html).toContain("&lt;b&gt;check&lt;/b&gt;");
  expect(html).toContain("&lt;script&gt;");
  expect(html).not.toMatch(/<script|<img|<b>/);
  expect(html).toContain("[Image blocked: x]");
  expect(html).toContain("[Image blocked: d]");
});

test("highlighting and diagrams load for every fence CommonMark accepts, nested too", () => {
  expect(pluginsFor("plain **text** with `inline` code")).toEqual([]);
  expect(pluginsFor("```ts\nconst a = 1\n```")).toEqual(["code"]);
  for (const fence of [
    "```mermaid",
    "~~~mermaid",
    "``` mermaid",
    "   ~~~~ Mermaid",
    "> ```mermaid",
    "- ```mermaid",
    "1. ~~~mermaid",
  ])
    expect(pluginsFor(`intro\n${fence}\ngraph TD; A-->B\n`)).toEqual([
      "code",
      "mermaid",
    ]);
});
