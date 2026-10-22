import { useCallback, useEffect, useState } from "react";
import type { JsonSchema } from "./action-form";
import type { ChatSession } from "./chat";
import type { UiPiece } from "./extension-ui";
import { errorMessage, fetchKernel, kernelUrl, request } from "./client";
import type { Actor } from "./client";

/** A setting of an extension; a secret's value never comes back, only whether it has one. */
export interface ExtensionSetting {
  key: string;
  type: "text" | "number" | "boolean" | "secret" | "choice";
  label: string;
  description: string;
  value: unknown;
  set: boolean;
  /** A choice's values, each with its label. */
  options?: { value: string; label: string }[];
}

/** An operation, defined once: a button, a tool for agents and an API. */
export interface ExtensionAction {
  extension: string;
  name: string;
  title: string;
  description: string;
  input: JsonSchema;
  output: JsonSchema | null;
  effects: "read" | "write" | "destructive";
  /** How long it may take, in seconds, when longer than a minute (at most 30 minutes). */
  seconds?: number;
}

/** What an extension brings, as its build declared it. */
export interface ExtensionContributes {
  actions: Omit<ExtensionAction, "extension">[];
  /** Extension points it opens, with their contracts. */
  points: {
    name: string;
    version: number;
    description: string;
    operations: {
      name: string;
      description: string;
      input: JsonSchema;
      output: JsonSchema | null;
    }[];
  }[];
  /** Extension points of others it implements. */
  implements: { point: string; name: string; title: string }[];
  events: { name: string; description: string }[];
  subscribes: string[];
  /** `event:<name>` or `schedule:<cron>`, and the action it runs. */
  triggers: { on: string; action: string }[];
  /** Pieces of interface it brings into the clients' spaces. */
  ui?: Omit<UiPiece, "extension">[];
}

/** A file of an extension's card, which the kernel gives at `url` only as its digest says. */
export interface CardFile {
  /** Its path in the package. */
  name: string;
  sha256: string;
  size: number;
  kind: "icon" | "image" | "video" | "text";
  /** On the kernel, `/api/extensions/assets/<sha256>`. */
  url: string;
}

/** What a marketplace shows of an extension: its card. */
export interface ExtensionCard {
  summary: string;
  /** One or two of `extensionCategories`. */
  categories: string[];
  keywords: string[];
  /** SPDX. */
  license: string | null;
  links: {
    homepage?: string | null;
    repository?: string | null;
    issues?: string | null;
    privacy?: string | null;
  } | null;
  icon: CardFile | null;
  icon_dark: CardFile | null;
  /** Its images and its video. */
  media: CardFile[];
  readme: CardFile | null;
  changelog: CardFile | null;
}

/** What an extension is for in a workspace, as marketplaces group them; a Lucide icon each. */
export const extensionCategories = [
  { id: "files-storage", name: "Files & Storage", icon: "folder-closed" },
  { id: "projects-tasks", name: "Projects & Tasks", icon: "square-kanban" },
  { id: "communication", name: "Communication", icon: "message-circle" },
  { id: "meetings-voice", name: "Meetings & Voice", icon: "audio-lines" },
  { id: "agents-ai", name: "Agents & AI", icon: "sparkles" },
  { id: "development", name: "Development", icon: "git-branch" },
  { id: "knowledge", name: "Knowledge", icon: "book-open" },
  { id: "data-analytics", name: "Data & Analytics", icon: "chart-column" },
  { id: "automation", name: "Automation", icon: "workflow" },
  { id: "calendar-time", name: "Calendar & Time", icon: "calendar-days" },
  { id: "customers-business", name: "Customers & Business", icon: "briefcase" },
  { id: "security-admin", name: "Security & Admin", icon: "shield-check" },
  { id: "other", name: "Other", icon: "shapes" },
] as const;

/** A card's file where a client reads it: on the kernel. */
export const cardFileUrl = (file: CardFile, kernel = kernelUrl()) =>
  `${kernel}${file.url}`;

/** A file a card's README shows, by its path in the package (`media/…`). */
export const cardFileNamed = (card: ExtensionCard, name: string) =>
  card.media.find((file) => file.name === name.replace(/^\.\//, ""));

/** A card's README or CHANGELOG, as Markdown. */
export const readCardText = (file: CardFile, kernel = kernelUrl()) =>
  fetchKernel(cardFileUrl(file, kernel)).then((response) => {
    if (!response.ok) throw new Error(`${file.name} could not be read`);
    return response.text();
  });

/** A card's icon for the theme: the dark one in dark themes, when there is one. */
export const cardIcon = (
  card: ExtensionCard | null | undefined,
  dark: boolean,
) => (dark && card?.icon_dark) || card?.icon || undefined;

/** An extension installed in the workspace, as people see it. */
export interface Extension {
  id: string;
  name: string;
  version: string;
  publisher: string;
  description: string;
  source: string;
  /** Loaded from a folder, in development. */
  dev: boolean;
  enabled: boolean;
  /** Its parts are running now. */
  running: boolean;
  error: string | null;
  dependencies: Record<string, string>;
  parts: string[];
  settings: ExtensionSetting[];
  contributes: ExtensionContributes | null;
  installed_at: number;
  updated_at: number;
  /** The agent that proposed it, until the owner enables it: its actor, or its session. */
  proposed_by?: string | null;
  /** Its card, from its folder. */
  card?: ExtensionCard | null;
}

/** Who proposed an extension, by name: its agent, or the session it came from. */
export const proposer = (
  extension: Extension,
  actors: Actor[],
  sessions: ChatSession[],
) =>
  actors.find((a) => a.id === extension.proposed_by)?.name ??
  (sessions.find((s) => s.id === extension.proposed_by)?.title || "an agent");

/**
 * Extensions agents proposed since the last look, to tell the owner: one proposed anew, or by
 * another agent. The first look tells nothing.
 */
export const newProposals = (
  before: Extension[] | undefined,
  after: Extension[],
) =>
  before
    ? after.filter(
        (e) =>
          e.proposed_by &&
          !before.some((b) => b.id === e.id && b.proposed_by === e.proposed_by),
      )
    : [];

/** The kernel's notice that the workspace's extensions changed: they are read again. */
export interface ExtensionsNotice {
  type: "extensions.changed";
}

const readers = new Set<() => void>();

/** Every shown list of extensions and actions reads again: a notice came, or may have been missed. */
export function extensionsNotice() {
  readers.forEach((read) => read());
}

/** What `load` reads from the kernel, read again whenever extensions change. */
export function useKernelList<T>(
  load: (kernel: string) => Promise<T>,
  kernel: string,
  enabled: boolean,
) {
  const [read, setRead] = useState<{
    kernel: string;
    items?: T;
    error?: string;
  }>();
  const reload = useCallback(
    async () =>
      enabled
        ? load(kernel).then(
            (items) => setRead({ kernel, items }),
            (error: unknown) =>
              setRead((was) => ({
                ...(was?.kernel === kernel ? was : { kernel }),
                error: errorMessage(error),
              })),
          )
        : undefined,
    [load, kernel, enabled],
  );
  useEffect(() => {
    void reload();
    const read = () => void reload();
    readers.add(read);
    return () => {
      readers.delete(read);
    };
  }, [reload]);
  const current = enabled && read?.kernel === kernel ? read : undefined;
  return { items: current?.items, error: current?.error ?? "", reload };
}

const readExtensions = (kernel: string) =>
  request<{ extensions?: Extension[] }>(kernel, "/extensions").then(
    (body) => body.extensions ?? [],
  );

const readActions = (kernel: string) =>
  request<{ actions?: ExtensionAction[] }>(kernel, "/actions").then(
    (body) => body.actions ?? [],
  );

/** The workspace's extensions, read again whenever they change. */
export function useExtensions(kernel = kernelUrl(), enabled = true) {
  const { items, ...rest } = useKernelList(readExtensions, kernel, enabled);
  return { extensions: items, ...rest };
}

/** The actions of the enabled extensions, read again whenever extensions change. */
export function useActions(kernel = kernelUrl(), enabled = true) {
  const { items, ...rest } = useKernelList(readActions, kernel, enabled);
  return { actions: items, ...rest };
}

const path = (id: string) => `/extensions/${encodeURIComponent(id)}`;
const changed = (work: Promise<{ extension: Extension }>) =>
  work.then(({ extension }) => extension);

/** The workspace's owner enables or disables an extension, removes it, or changes its settings. */
export const enableExtension = (id: string, kernel = kernelUrl()) =>
  changed(request(kernel, `${path(id)}/enable`, {}));

export const disableExtension = (id: string, kernel = kernelUrl()) =>
  changed(request(kernel, `${path(id)}/disable`, {}));

export const removeExtension = (id: string, kernel = kernelUrl()) =>
  request<{ removed: boolean }>(
    kernel,
    path(id),
    undefined,
    undefined,
    "DELETE",
  );

/** Removes an installed extension: the kernel removes only a disabled one, so it is disabled first. */
export async function removeInstalled(
  extension: Pick<Extension, "id" | "enabled">,
  kernel = kernelUrl(),
) {
  if (extension.enabled) await disableExtension(extension.id, kernel);
  return removeExtension(extension.id, kernel);
}

/** Settings and secrets by key; `null` takes one away. */
export const setExtensionSettings = (
  id: string,
  changes: Record<string, unknown>,
  kernel = kernelUrl(),
) =>
  changed(request(kernel, `${path(id)}/settings`, changes, undefined, "PATCH"));

/** An extension an index offers, and what of it is installed. */
export interface MarketplaceOffer {
  /** The index that offers it, by its address. */
  index: string;
  id: string;
  name: string;
  description: string;
  publisher: string;
  /** Its newest version that runs on this kernel. */
  version: string;
  installed: string | null;
  /**
   * Whether the installed one is this very package: `false` is another, even of the same
   * version; `null` is not known, as for one loaded from a folder.
   */
  current?: boolean | null;
  /** Its parts, where the index says: `kernel` runs inside the kernel. */
  parts?: string[];
  /** Its card, where the index has one. */
  card?: ExtensionCard | null;
}

export interface Marketplace {
  offers: MarketplaceOffer[];
  /** Each index read, by its name, even one that offers nothing. */
  marketplaces: { index: string; name: string }[];
  /** Indexes that could not be read, each with why. */
  errors: { index: string; error: string }[];
}

const readMarketplace = (kernel: string) =>
  request<Partial<Marketplace>>(kernel, "/extensions/marketplace").then(
    (body): Marketplace => ({
      offers: body.offers ?? [],
      marketplaces: body.marketplaces ?? [],
      errors: body.errors ?? [],
    }),
  );

/** A marketplace by its name, or else by its host; a local one is on this computer. */
export function marketplaceName(index: string, marketplace?: Marketplace) {
  const named = marketplace?.marketplaces.find((m) => m.index === index)?.name;
  if (named) return named;
  try {
    const url = new URL(index);
    return url.protocol === "file:" ? "This computer" : url.host || index;
  } catch {
    return index;
  }
}

/** Every index of the marketplace, read or not. */
export const marketplaceIndexes = (marketplace?: Marketplace) => [
  ...new Set(
    [
      ...(marketplace?.marketplaces ?? []),
      ...(marketplace?.offers ?? []),
      ...(marketplace?.errors ?? []),
    ].map((source) => source.index),
  ),
];

/** What the indexes offer, read again whenever extensions change. */
export function useMarketplace(kernel = kernelUrl(), enabled = true) {
  const { items, ...rest } = useKernelList(readMarketplace, kernel, enabled);
  return { marketplace: items, ...rest };
}

/**
 * What an offer's button does: install it, update it to its newest version, or nothing. A new
 * build of the version installed is an update too.
 */
export const offerAction = (offer: MarketplaceOffer) =>
  offer.installed === null || offer.installed === undefined
    ? "install"
    : offer.installed === offer.version && offer.current !== false
      ? "installed"
      : "update";

/** An offer's version, and in an update the one it replaces: a new build of the same says so. */
export const offerVersions = (offer: MarketplaceOffer) =>
  offerAction(offer) !== "update"
    ? offer.version
    : offer.installed === offer.version
      ? `${offer.version} · new build`
      : `${offer.installed} → ${offer.version}`;

/** What a marketplace offers of an installed extension: its update, when there is one. */
export const offerFor = (extension: Extension, offers: MarketplaceOffer[]) =>
  extension.dev ? undefined : offers.find((offer) => offer.id === extension.id);

/**
 * The workspace's extensions as the Extensions page lists them: what an update waits for,
 * then those running, those disabled, and those loaded from a folder; agents' proposals apart,
 * until the owner enables them.
 */
export function extensionGroups(
  extensions: Extension[],
  offers: MarketplaceOffer[],
) {
  const proposals = extensions.filter((e) => e.proposed_by);
  const settled = extensions.filter((e) => !e.proposed_by);
  return {
    updates: settled.flatMap((extension) => {
      const offer = offerFor(extension, offers);
      return offer && offerAction(offer) === "update"
        ? [{ extension, offer }]
        : [];
    }),
    active: settled.filter((e) => !e.dev && e.enabled),
    disabled: settled.filter((e) => !e.dev && !e.enabled),
    development: settled.filter((e) => e.dev),
    proposals,
  };
}

/**
 * What installing or updating to an offer runs, said before it does: each part, and in an
 * update whether it is new, or no longer there.
 */
export function consentParts(offer: MarketplaceOffer, installed?: Extension) {
  const before = installed?.parts ?? [];
  // An index that does not say its parts changes none of what is known.
  const now = offer.parts ?? before;
  return [
    ...now.map((part) => ({
      part,
      change: installed && !before.includes(part) ? "new" : "kept",
    })),
    ...before
      .filter((part) => !now.includes(part))
      .map((part) => ({ part, change: "gone" })),
  ] as { part: string; change: "new" | "kept" | "gone" }[];
}

/**
 * What parts let run beyond their own process, and from whom: code inside the kernel, an
 * interface inside the apps; nothing when they are neither.
 */
function partsWarning(parts: string[] | undefined, from: string) {
  const said = [
    parts?.includes("kernel") ? `It runs inside the kernel, ${from}.` : "",
    parts?.includes("interface")
      ? `Its interface runs inside the app with your access, ${from}.`
      : "",
  ].filter(Boolean);
  return said.length ? said.join(" ") : undefined;
}

/** What installing an offer lets run beyond its own process, said before it is installed. */
export const offerWarning = (offer: MarketplaceOffer) =>
  partsWarning(offer.parts, `signed by ${offer.publisher}`);

/** What enabling an agent's proposal lets run beyond its own process, said before it is enabled. */
export const proposalWarning = (extension: Extension, agent: string) =>
  partsWarning(extension.parts, `proposed by ${agent}`);

/** The owner installs an extension from an index, or updates it, and enables it. */
export const installOffer = (offer: MarketplaceOffer, kernel = kernelUrl()) =>
  changed(
    request(kernel, "/extensions/marketplace/install", {
      index: offer.index,
      id: offer.id,
      version: offer.version,
    }),
  );

/** What updating several extensions did: those updated, and those that failed with why. */
export interface UpdatesDone {
  updated: { id: string; version: string }[];
  failed: { id: string; error: string }[];
}

/** The owner updates the extensions named, each from the index it came from. */
export const updateExtensions = (ids: string[], kernel = kernelUrl()) =>
  request<UpdatesDone>(kernel, "/extensions/marketplace/update", { ids });

/** An extension from a folder on the kernel's computer, in development. */
export const loadExtensionFolder = (folder: string, kernel = kernelUrl()) =>
  changed(request(kernel, "/extensions/folder", { folder }));

/** Runs an action with its input, as people and agents do: its result. */
export const runAction = (
  extension: string,
  name: string,
  input: Record<string, unknown>,
  kernel = kernelUrl(),
  signal?: AbortSignal,
) =>
  request<{ result: unknown }>(
    kernel,
    `/ext/${encodeURIComponent(extension)}/${encodeURIComponent(name)}`,
    input,
    signal,
  ).then(({ result }) => result);
