import { afterEach, expect, mock, test } from "bun:test";
import { reportPages } from "./desktop";

const told: string[] = [];
mock.module("@tauri-apps/api/core", () => ({
  invoke: async (command: string) => void told.push(command),
}));

const cleanups: (() => void)[] = [];
afterEach(() => {
  cleanups
    .splice(0)
    .reverse()
    .forEach((stop) => stop());
  told.length = 0;
});

/** A page whose moves are kept, in the desktop app or in a browser. */
function page(desktop: boolean) {
  const moves: string[] = [];
  const pageHistory = {
    pushState: (_: unknown, __: string, url?: string) => moves.push(`+${url}`),
    replaceState: (_: unknown, __: string, url?: string) =>
      moves.push(`=${url}`),
  };
  const saved = ["window", "history"].map(
    (name) =>
      [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const,
  );
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: desktop ? { zeroluxDesktop: { profileId: "aspen" } } : {},
  });
  Object.defineProperty(globalThis, "history", {
    configurable: true,
    value: pageHistory,
  });
  cleanups.push(() => {
    for (const [name, before] of saved)
      if (before) Object.defineProperty(globalThis, name, before);
      else Reflect.deleteProperty(globalThis, name);
  });
  return { history: pageHistory, moves };
}

const settled = () => new Promise((resolve) => setTimeout(resolve, 10));

test("a desktop window tells the desktop each page it goes to, whoever moves it", async () => {
  const { history, moves } = page(true);
  cleanups.push(reportPages());
  history.pushState(null, "", "/w/aspen/chats");
  history.replaceState(null, "", "/w/aspen/console");
  dispatchEvent(new Event("popstate"));
  dispatchEvent(new Event("hashchange"));
  await settled();
  // The page still moves as it asked.
  expect(moves).toEqual(["+/w/aspen/chats", "=/w/aspen/console"]);
  expect(told).toEqual([
    "desktop_page",
    "desktop_page",
    "desktop_page",
    "desktop_page",
  ]);
});

test("a page in a browser tells no desktop", async () => {
  const { history, moves } = page(false);
  cleanups.push(reportPages());
  history.pushState(null, "", "/w/aspen/chats");
  dispatchEvent(new Event("popstate"));
  await settled();
  expect(moves).toEqual(["+/w/aspen/chats"]);
  expect(told).toEqual([]);
});
