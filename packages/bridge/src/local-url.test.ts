import { expect, test } from "bun:test";
import { localURL } from "./local-url.ts";

test("local URLs reject remote targets, credentials, and deceptive paths", () => {
  expect(localURL("http://localhost:4310/")).toBe("http://127.0.0.1:4310");
  expect(localURL("http://[::1]:4310")).toBe("http://[::1]:4310");
  for (const url of [
    "https://127.0.0.1",
    "http://example.com",
    "http://user:secret@localhost",
    "http://localhost/path",
    "http://localhost?x=1",
    "http://localhost#x",
  ]) {
    expect(() => localURL(url)).toThrow();
  }
});
