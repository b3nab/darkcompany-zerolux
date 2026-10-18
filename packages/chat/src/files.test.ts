import { expect, test } from "bun:test";
import { mentionAt, withMention } from "./files";

test("a file mention is the @ word under the cursor", () => {
  expect(mentionAt("@", 1)).toEqual({ query: "", start: 0, end: 1 });
  expect(mentionAt("look at @src/ma", 15)).toEqual({
    query: "src/ma",
    start: 8,
    end: 15,
  });
  // The word runs on past the cursor; what follows the cursor is replaced too.
  expect(mentionAt("open @apps/web now", 9)).toEqual({
    query: "app",
    start: 5,
    end: 14,
  });
  // An address, a word that is gone, or text without one: no mention.
  expect(mentionAt("write to owner@example.com", 26)).toBeUndefined();
  expect(mentionAt("@src done", 9)).toBeUndefined();
  expect(mentionAt("plain text", 5)).toBeUndefined();
});

test("choosing a file puts its path in place of the mention", () => {
  const text = "look at @src/ma and tell me";
  const mention = mentionAt(text, 15)!;
  expect(withMention(text, mention, "src/main.rs")).toEqual({
    text: "look at @src/main.rs and tell me",
    cursor: 21,
  });
  expect(withMention("@", mentionAt("@", 1)!, "README.md")).toEqual({
    text: "@README.md ",
    cursor: 11,
  });
});
