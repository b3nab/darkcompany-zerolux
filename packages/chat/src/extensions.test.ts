import { afterEach, expect, test } from "bun:test";
import { setKernelFetch } from "./client";
import {
  installOffer,
  newProposals,
  offerAction,
  offerWarning,
  proposalWarning,
  proposer,
  disableExtension,
  enableExtension,
  loadExtensionFolder,
  removeExtension,
  runAction,
  setExtensionSettings,
} from "./extensions";
import type { Actor } from "./client";
import type { ChatSession } from "./chat";
import type { Extension, MarketplaceOffer } from "./extensions";

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
  expect(offerAction({ ...offer, installed: "1.2.0", current: true })).toBe(
    "installed",
  );
  // Another build of the same version is an update; one that cannot be told apart is not.
  expect(offerAction({ ...offer, installed: "1.2.0", current: false })).toBe(
    "update",
  );
  expect(offerAction({ ...offer, installed: "1.2.0", current: null })).toBe(
    "installed",
  );
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

const proposal = (id: string, proposed_by: string | null) =>
  ({ id, parts: ["process"], proposed_by }) as Extension;

test("the owner hears of an agent's proposal once, and of none at the first look", () => {
  const notes = proposal("aspen.notes", "birch");
  expect(newProposals(undefined, [notes])).toEqual([]);
  expect(newProposals([], [notes])).toEqual([notes]);
  expect(newProposals([notes], [notes])).toEqual([]);
  // Proposed again by another agent.
  const cedar = proposal("aspen.notes", "cedar");
  expect(newProposals([notes], [cedar])).toEqual([cedar]);
  // Enabled by the owner, it is no proposal.
  expect(newProposals([notes], [proposal("aspen.notes", null)])).toEqual([]);
  expect(newProposals([], [proposal("aspen.tasks", null)])).toEqual([]);
});

test("a proposal names its agent, or the session it came from", () => {
  const actors = [{ id: "a1", name: "birch" }] as Actor[];
  const sessions = [{ id: "s1", title: "Notes" }] as ChatSession[];
  expect(proposer(proposal("aspen.notes", "a1"), actors, sessions)).toBe(
    "birch",
  );
  expect(proposer(proposal("aspen.notes", "s1"), actors, sessions)).toBe(
    "Notes",
  );
});

test("a proposal warns before it is enabled only of what runs beyond its own process", () => {
  const notes = proposal("aspen.notes", "a1");
  expect(proposalWarning(notes, "birch")).toBeUndefined();
  expect(
    proposalWarning({ ...notes, parts: ["kernel", "interface"] }, "birch"),
  ).toContain("birch");
});
