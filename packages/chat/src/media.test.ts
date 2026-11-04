import { afterEach, expect, test } from "bun:test";
import { setKernelFetch } from "./client";
import { bindCredential } from "./credentials";
import { localImage, localPath, sessionMedia } from "./media";

afterEach(() => setKernelFetch());

test("a link names a file on the session's computer only when it is a path, never the web", () => {
  expect(localPath("/tmp/run/browser.png")).toBe("/tmp/run/browser.png");
  expect(localPath("~/Desktop/shot.png")).toBe("~/Desktop/shot.png");
  expect(localPath("./out/report.md")).toBe("./out/report.md");
  expect(localPath("../shots/a b.png")).toBe("../shots/a b.png");
  expect(localPath("/tmp/a%20b.png")).toBe("/tmp/a b.png");
  expect(localPath("<~/My Shots/x.png>")).toBe("~/My Shots/x.png");
  expect(localPath("file:///tmp/a%20b.png")).toBe("/tmp/a b.png");
  expect(localPath("file:///C:/shots/x.png")).toBe("C:/shots/x.png");
  expect(localPath("C:\\shots\\x.png")).toBe("C:\\shots\\x.png");
  for (const web of [
    "https://example.com/x.png",
    "//cdn.example.com/x.png",
    "mailto:aspen@example.com",
    "#section",
    "docs/readme.md",
  ])
    expect(localPath(web)).toBeUndefined();
});

test("a picture by its extension, whatever its case or a query after it", () => {
  for (const name of [
    "a.png",
    "b.JPG",
    "c.jpeg",
    "d.gif",
    "e.webp",
    "f.avif",
    "g.bmp",
    "h.png?v=2",
  ])
    expect(localImage(name)).toBe(true);
  for (const name of ["a.pdf", "b.svg", "c.png.txt", "d"])
    expect(localImage(name)).toBe(false);
});

test("a session's image is read from its kernel with the person's own token", () => {
  const kernel = "http://192.0.2.10:4310/w/ws-a";
  bindCredential(kernel, "maple-token");
  const media = sessionMedia("s/1", "~/x y.png", kernel);
  expect(media.uri).toBe(
    "http://192.0.2.10:4310/w/ws-a/api/sessions/s%2F1/media?path=~%2Fx%20y.png",
  );
  expect(media.headers).toEqual({ Authorization: "Bearer maple-token" });
});
