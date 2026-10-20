import { afterEach, expect, test } from "bun:test";
import { setKernelFetch } from "./client";
import {
  installOffer,
  offerAction,
  offerWarning,
  disableExtension,
  enableExtension,
  installExtension,
  loadExtensionFolder,
  removeExtension,
  runAction,
  setExtensionSettings,
} from "./extensions";
import type { MarketplaceOffer } from "./extensions";

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

const offer: MarketplaceOffer = {
  index: "https://example.test/index.json",
  id: "aspen.notes",
  name: "Notes",
  description: "Notes kept where you choose",
  publisher: "aspen",
  version: "1.2.0",
  installed: null,
};

test("an offer is installed, updated to its newest version, or already there", () => {
  expect(offerAction(offer)).toBe("install");
  expect(offerAction({ ...offer, installed: "1.1.0" })).toBe("update");
  expect(offerAction({ ...offer, installed: "1.2.0" })).toBe("installed");
});

test("installing an offer asks its index for that version, and gives the extension", async () => {
  const asked: { url: string; body: unknown }[] = [];
  setKernelFetch(async (url, init) => {
    asked.push({ url: String(url), body: JSON.parse(String(init?.body)) });
    return Response.json({
      extension: { id: "aspen.notes", version: "1.2.0" },
    });
  });
  const installed = await installOffer(
    { ...offer, installed: "1.1.0" },
    kernel,
  );
  expect(installed).toMatchObject({ id: "aspen.notes", version: "1.2.0" });
  expect(asked).toEqual([
    {
      url: `${kernel}/api/extensions/marketplace/install`,
      body: {
        index: "https://example.test/index.json",
        id: "aspen.notes",
        version: "1.2.0",
      },
    },
  ]);
});

test("an offer warns before it is installed only of what runs beyond its own process", () => {
  expect(offerWarning(offer)).toBeUndefined();
  expect(offerWarning({ ...offer, parts: ["process"] })).toBeUndefined();
  const kernel = offerWarning({ ...offer, parts: ["kernel"] });
  const ui = offerWarning({ ...offer, parts: ["interface"] });
  expect(kernel).toContain("aspen");
  expect(ui).toContain("aspen");
  expect(ui).not.toBe(kernel);
  // Both, in one warning.
  expect(offerWarning({ ...offer, parts: ["kernel", "interface"] })).toBe(
    `${kernel} ${ui}`,
  );
});
