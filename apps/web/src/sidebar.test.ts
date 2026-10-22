import { expect, test } from "bun:test";
import { arranged } from "./Sidebar";

const bar = ["/", "/console", "/chats", "/x/aspen.notes/notes", "/extensions"];

test("the bar keeps the order the person put it in", () => {
  expect(arranged(bar, [])).toEqual(bar);
  expect(
    arranged(bar, [
      "/chats",
      "/",
      "/console",
      "/x/aspen.notes/notes",
      "/extensions",
    ]),
  ).toEqual(["/chats", "/", "/console", "/x/aspen.notes/notes", "/extensions"]);
});

test("a section never placed stays after the one it follows; one gone is left out", () => {
  const kept = ["/extensions", "/chats", "/", "/console", "/x/birch.gone/page"];
  expect(arranged(bar, kept)).toEqual([
    "/extensions",
    "/chats",
    "/x/aspen.notes/notes",
    "/",
    "/console",
  ]);
  expect(arranged(["/new", ...bar], kept)[0]).toBe("/new");
});
