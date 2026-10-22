import { afterEach, expect, test } from "bun:test";
import { setKernelFetch } from "./client";
import {
  cardFileNamed,
  cardFileUrl,
  cardIcon,
  consentParts,
  extensionGroups,
  installOffer,
  marketplaceIndexes,
  marketplaceName,
  newProposals,
  offerAction,
  offerWarning,
  proposalWarning,
  proposer,
  disableExtension,
  enableExtension,
  loadExtensionFolder,
  removeExtension,
  removeInstalled,
  runAction,
  setExtensionSettings,
  updateExtensions,
} from "./extensions";
import type { Actor } from "./client";
import type { CardFile, ExtensionCard } from "./extensions";
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

test("the installed are listed by what they wait for, agents' proposals apart", () => {
  const installed = (id: string, more: Partial<Extension> = {}) =>
    ({
      id,
      enabled: true,
      dev: false,
      parts: ["process"],
      proposed_by: null,
      ...more,
    }) as Extension;
  const notes = installed("aspen.notes");
  const groups = extensionGroups(
    [
      notes,
      installed("birch.board", { enabled: false }),
      installed("cedar.draft", { dev: true }),
      installed("maple.report", { enabled: false, proposed_by: "agent-1" }),
    ],
    [
      { ...offer, installed: "1.1.0" },
      { ...offer, id: "cedar.draft", installed: "0.1.0" },
    ],
  );
  expect(groups.updates).toEqual([
    { extension: notes, offer: { ...offer, installed: "1.1.0" } },
  ]);
  expect(groups.active.map((e) => e.id)).toEqual(["aspen.notes"]);
  expect(groups.disabled.map((e) => e.id)).toEqual(["birch.board"]);
  // One loaded from a folder updates from its folder, never from a marketplace.
  expect(groups.development.map((e) => e.id)).toEqual(["cedar.draft"]);
  expect(groups.proposals.map((e) => e.id)).toEqual(["maple.report"]);
});

test("a consent says what runs, and in an update what is new or gone", () => {
  const installed = {
    id: "aspen.notes",
    parts: ["process", "interface"],
  } as Extension;
  expect(consentParts({ ...offer, parts: ["process"] })).toEqual([
    { part: "process", change: "kept" },
  ]);
  expect(
    consentParts({ ...offer, parts: ["kernel", "interface"] }, installed),
  ).toEqual([
    { part: "kernel", change: "new" },
    { part: "interface", change: "kept" },
    { part: "process", change: "gone" },
  ]);
  // An index that does not say its parts changes none of what is known.
  expect(consentParts(offer, installed).every((p) => p.change === "kept")).toBe(
    true,
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

test("a marketplace is named by its index, else by its host, and a local one is this computer's", () => {
  const marketplace = {
    offers: [],
    marketplaces: [{ index: "https://192.0.2.1/index.json", name: "Aspen" }],
    errors: [{ index: "https://192.0.2.2/index.json", error: "Gone" }],
  };
  expect(marketplaceName("https://192.0.2.1/index.json", marketplace)).toBe(
    "Aspen",
  );
  expect(marketplaceName("https://192.0.2.2/index.json", marketplace)).toBe(
    "192.0.2.2",
  );
  expect(marketplaceName("file:///tmp/marketplace/index.json")).toBe(
    "This computer",
  );
  expect(marketplaceIndexes(marketplace)).toEqual([
    "https://192.0.2.1/index.json",
    "https://192.0.2.2/index.json",
  ]);
});

test("a card's files are read on the kernel, its icon follows the theme, its README's images by name", () => {
  const file = (name: string, kind: CardFile["kind"]): CardFile => ({
    name,
    sha256: name,
    size: 1,
    kind,
    url: `/api/extensions/assets/${name}`,
  });
  const card: ExtensionCard = {
    summary: "",
    categories: ["knowledge"],
    keywords: [],
    license: null,
    links: null,
    icon: file("icon.png", "icon"),
    icon_dark: null,
    media: [file("media/one.png", "image")],
    readme: null,
    changelog: null,
  };
  expect(cardFileUrl(card.icon!, "http://192.0.2.1:4310")).toBe(
    "http://192.0.2.1:4310/api/extensions/assets/icon.png",
  );
  expect(cardIcon(card, true)?.name).toBe("icon.png");
  expect(
    cardIcon({ ...card, icon_dark: file("dark.png", "icon") }, true)?.name,
  ).toBe("dark.png");
  expect(cardFileNamed(card, "./media/one.png")?.kind).toBe("image");
  expect(cardFileNamed(card, "media/two.png")).toBeUndefined();
});

test("an enabled extension is disabled before it is removed; a disabled one is removed at once", async () => {
  const asked: string[] = [];
  setKernelFetch(async (url, init) => {
    asked.push(`${init?.method ?? "GET"} ${new URL(String(url)).pathname}`);
    return init?.method === "DELETE"
      ? Response.json({ removed: true })
      : Response.json({ extension: { id: "acme.notes" } });
  });
  await removeInstalled({ id: "acme.notes", enabled: true }, kernel);
  await removeInstalled({ id: "acme.notes", enabled: false }, kernel);
  expect(asked).toEqual([
    "POST /api/extensions/acme.notes/disable",
    "DELETE /api/extensions/acme.notes",
    "DELETE /api/extensions/acme.notes",
  ]);
});

test("updating several extensions names the ones shown, and says which were and which failed", async () => {
  const asked: { path: string; body: unknown }[] = [];
  setKernelFetch(async (url, init) => {
    asked.push({
      path: new URL(String(url)).pathname,
      body: JSON.parse(String(init?.body)),
    });
    return Response.json({
      updated: [{ id: "aspen.notes", version: "1.2.0" }],
      failed: [{ id: "birch.board", error: "Cannot reach it" }],
    });
  });
  const done = await updateExtensions(["aspen.notes", "birch.board"], kernel);
  expect(asked).toEqual([
    {
      path: "/api/extensions/marketplace/update",
      body: { ids: ["aspen.notes", "birch.board"] },
    },
  ]);
  expect(done.failed[0]!.error).toBe("Cannot reach it");
});
