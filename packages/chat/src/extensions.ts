import { useCallback, useEffect, useState } from "react";
import type { JsonSchema } from "./action-form";
import type { UiPiece } from "./extension-ui";
import { errorMessage, kernelUrl, request } from "./client";

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
}

/** An official extension ZeroLux brings, installed or not. */
export interface OfficialExtension {
  id: string;
  name: string;
  version: string;
  publisher: string;
  description: string;
  installed: boolean;
}

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

const readOfficial = (kernel: string) =>
  request<{ extensions?: OfficialExtension[] }>(
    kernel,
    "/extensions/available",
  ).then((body) => body.extensions ?? []);

/** The workspace's extensions, read again whenever they change. */
export function useExtensions(kernel = kernelUrl(), enabled = true) {
  const { items, ...rest } = useKernelList(readExtensions, kernel, enabled);
  return { extensions: items, ...rest };
}

/** The official extensions this kernel brings, read again whenever extensions change. */
export function useOfficialExtensions(kernel = kernelUrl(), enabled = true) {
  const { items, ...rest } = useKernelList(readOfficial, kernel, enabled);
  return { official: items, ...rest };
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
  /** Its parts, where the index says: `kernel` runs inside the kernel. */
  parts?: string[];
}

export interface Marketplace {
  offers: MarketplaceOffer[];
  /** Indexes that could not be read, each with why. */
  errors: { index: string; error: string }[];
}

const readMarketplace = (kernel: string) =>
  request<Partial<Marketplace>>(kernel, "/extensions/marketplace").then(
    (body): Marketplace => ({
      offers: body.offers ?? [],
      errors: body.errors ?? [],
    }),
  );

/** What the indexes offer, read again whenever extensions change. */
export function useMarketplace(kernel = kernelUrl(), enabled = true) {
  const { items, ...rest } = useKernelList(readMarketplace, kernel, enabled);
  return { marketplace: items, ...rest };
}

/** What an offer's button does: install it, update it to its newest version, or nothing. */
export const offerAction = (offer: MarketplaceOffer) =>
  offer.installed === null || offer.installed === undefined
    ? "install"
    : offer.installed === offer.version
      ? "installed"
      : "update";

/**
 * What installing an offer lets run beyond its own process, said before it is installed:
 * code inside the kernel, an interface inside the apps; nothing when it is neither.
 */
export function offerWarning(offer: MarketplaceOffer) {
  const by = `signed by ${offer.publisher}.`;
  const said = [
    offer.parts?.includes("kernel") ? `It runs inside the kernel, ${by}` : "",
    offer.parts?.includes("interface")
      ? `Its interface runs inside the app with your access, ${by}`
      : "",
  ].filter(Boolean);
  return said.length ? said.join(" ") : undefined;
}

/** The owner installs an extension from an index, or updates it, and enables it. */
export const installOffer = (offer: MarketplaceOffer, kernel = kernelUrl()) =>
  changed(
    request(kernel, "/extensions/marketplace/install", {
      index: offer.index,
      id: offer.id,
      version: offer.version,
    }),
  );

/** The owner installs and enables an official extension, from where the kernel carries it. */
export const installExtension = (id: string, kernel = kernelUrl()) =>
  changed(
    request(kernel, `/extensions/available/${encodeURIComponent(id)}`, {}),
  );

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
