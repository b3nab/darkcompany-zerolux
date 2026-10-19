import { afterEach, expect, test } from "bun:test";
import { setKernelFetch } from "./client";
import {
  disableExtension,
  enableExtension,
  installExtension,
  loadExtensionFolder,
  removeExtension,
  runAction,
  setExtensionSettings,
} from "./extensions";

afterEach(() => setKernelFetch());

const kernel = "http://192.0.2.4:4400";

test("the owner's changes go to the kernel's extension routes", async () => {
  const asked: { method: string; path: string; body: unknown }[] = [];
  setKernelFetch(async (url, init) => {
    const { pathname } = new URL(String(url));
    asked.push({
      method: init?.method ?? "GET",
      path: pathname,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    if (pathname.startsWith("/api/ext/"))
      return Response.json({ result: { created: 1 } });
    if (init?.method === "DELETE") return Response.json({ removed: true });
    return Response.json({ extension: { id: "acme.notes" } });
  });
  expect((await enableExtension("acme.notes", kernel)).id).toBe("acme.notes");
  await disableExtension("acme.notes", kernel);
  await setExtensionSettings(
    "acme.notes",
    { greeting: "hi", token: null },
    kernel,
  );
  await loadExtensionFolder("/work/notes", kernel);
  await installExtension("zerolux.voice", kernel);
  await removeExtension("acme.notes", kernel);
  expect(
    await runAction("acme.notes", "notes.add", { text: "a/b" }, kernel),
  ).toEqual({ created: 1 });
  expect(asked).toEqual([
    { method: "POST", path: "/api/extensions/acme.notes/enable", body: {} },
    { method: "POST", path: "/api/extensions/acme.notes/disable", body: {} },
    {
      method: "PATCH",
      path: "/api/extensions/acme.notes/settings",
      body: { greeting: "hi", token: null },
    },
    {
      method: "POST",
      path: "/api/extensions/folder",
      body: { folder: "/work/notes" },
    },
    {
      method: "POST",
      path: "/api/extensions/available/zerolux.voice",
      body: {},
    },
    { method: "DELETE", path: "/api/extensions/acme.notes", body: undefined },
    {
      method: "POST",
      path: "/api/ext/acme.notes/notes.add",
      body: { text: "a/b" },
    },
  ]);
});
