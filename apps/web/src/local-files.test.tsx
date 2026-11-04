import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { MessageText } from "@/components/message-text";
import {
  SessionFilesProvider,
  imagesIn,
  inFolder,
} from "@/components/local-files";

const files = {
  id: "aspen",
  folder: "/work/aspen",
  images: ["/tmp/run/shot.png"],
  here: false,
  openFile: () => {},
};

test("an agent's link to a file on its computer is a chip, never a link the page follows", () => {
  const text =
    "Evidence: [browser](/tmp/run/shot.png), [notes](./docs/a.md), [home](~/x.png), [file](file:///tmp/y.png), [log](/tmp/run/out.txt) and [site](https://example.org/)";
  const inSession = renderToStaticMarkup(
    <SessionFilesProvider files={files}>
      <MessageText text={text} />
    </SessionFilesProvider>,
  );
  // Each file opens from a button; no link of the page goes to it.
  for (const path of [
    "/tmp/run/shot.png",
    "./docs/a.md",
    "~/x.png",
    "/tmp/run/out.txt",
  ]) {
    expect(inSession).toContain(`title="${path}"`);
    expect(inSession).not.toContain(`href="${path}"`);
  }
  expect(inSession).not.toContain('href="/docs');
  expect(inSession).not.toContain("file://");
  expect(inSession.match(/<button/g)).toHaveLength(5);
  // A web link stays one.
  expect(inSession).toContain('href="https://example.org/"');
  // Outside a session the path stays, with nothing to open.
  const alone = renderToStaticMarkup(<MessageText text={text} />);
  expect(alone).not.toContain("<button");
  expect(alone).toContain('title="/tmp/run/shot.png"');
  expect(alone).not.toContain('href="/tmp');
});

test("the lightbox goes through a session's images in their order, each once, never one in code", () => {
  expect(
    imagesIn([
      "See ![](/tmp/a.png) and [the next](/tmp/b.jpg)",
      "```\n[in code](/tmp/c.png)\n```\nand `[inline](/tmp/d.png)`",
      "[again](/tmp/a.png), [a note](/tmp/e.txt), [web](https://example.org/f.png)",
    ]),
  ).toEqual(["/tmp/a.png", "/tmp/b.jpg"]);
});

test("a file of the session's folder opens there, by its path in it; one outside does not", () => {
  expect(inFolder("/work/aspen", "/work/aspen/src/x.ts")).toBe("src/x.ts");
  expect(inFolder("/work/aspen/", "./src/x.ts")).toBe("src/x.ts");
  expect(inFolder("/work/aspen", "/work/aspen-two/y.ts")).toBeUndefined();
  expect(inFolder("/work/aspen", "/work/aspen/../z.ts")).toBeUndefined();
  expect(inFolder("/work/aspen", "../z.ts")).toBeUndefined();
  expect(inFolder("/work/aspen", "/tmp/z.ts")).toBeUndefined();
});
