import { afterAll, afterEach, expect, test } from "bun:test";
import type { KernelInstance } from "@zerolux/chat";
import { place, WORKSPACES_PAGE } from "./instance";

const kernel = "http://192.0.2.10:4310";
const served = (...names: string[]): KernelInstance => ({
  kernel,
  multi: true,
  workspaces: names.map((name) => ({
    id: name,
    name,
    base: `${kernel}/w/${name}`,
  })),
});
const older: KernelInstance = {
  kernel,
  multi: false,
  workspaces: [{ id: "aspen", name: "aspen", base: kernel }],
};

const kept = new Map<string, string>();
const storage = globalThis.localStorage;
globalThis.localStorage = {
  getItem: (key: string) => kept.get(key) ?? null,
  setItem: (key: string, value: string) => void kept.set(key, value),
} as Storage;
afterEach(() => kept.clear());
afterAll(() => {
  globalThis.localStorage = storage;
});

test("an older kernel's one workspace is at its origin, its pages at the root", () => {
  expect(place(older, "/chats")).toEqual({
    here: { instance: older, workspace: older.workspaces[0]! },
    basename: "",
    address: undefined,
  });
  // A page address of a newer kernel, opened on an older one, loses its workspace.
  expect(place(older, "/w/aspen/chats")).toMatchObject({ address: "/chats" });
  expect(place(older, "/w/aspen")).toMatchObject({ address: "/" });
});

test("a browser is in the workspace its address names, its pages under it", () => {
  const instance = served("aspen", "birch");
  expect(place(instance, "/w/birch/chats/1")).toEqual({
    here: { instance, workspace: instance.workspaces[1]! },
    basename: "/w/birch",
    address: undefined,
  });
  expect(place(instance, "/w/cedar/chats")).toEqual({ choose: instance });
});

test("a kernel's only workspace opens at once, its address gaining the workspace", () => {
  const instance = served("aspen");
  expect(place(instance, "/chats/1")).toMatchObject({
    basename: "/w/aspen",
    address: "/w/aspen/chats/1",
  });
  expect(place(instance, "/")).toMatchObject({ address: "/w/aspen/" });
});

test("of several workspaces, the one chosen last opens, else they are listed", () => {
  const instance = served("aspen", "birch");
  expect(place(instance, "/")).toEqual({ choose: instance });
  kept.set(`zerolux.workspace.${kernel}`, "birch");
  expect(place(instance, "/")).toMatchObject({ basename: "/w/birch" });
  // Their list is asked for by its own address.
  expect(place(instance, WORKSPACES_PAGE)).toEqual({ choose: instance });
  kept.set(`zerolux.workspace.${kernel}`, "cedar");
  expect(place(instance, "/")).toEqual({ choose: instance });
});

test("a desktop window is in its own workspace, whatever its address", () => {
  const instance = served("aspen", "birch");
  expect(place(instance, "/chats", "birch")).toEqual({
    here: { instance, workspace: instance.workspaces[1]! },
    basename: "",
  });
  expect(place(instance, "/", "cedar")).toEqual({ choose: instance });
  expect(place(older, "/", "aspen")).toMatchObject({ basename: "" });
});
