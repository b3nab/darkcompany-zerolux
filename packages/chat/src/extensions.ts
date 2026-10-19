import { useCallback, useEffect, useState } from "react";
import type { JsonSchema } from "./action-form";
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

/** The kernel's notice that the workspace's extensions changed: they are read again. */
export interface ExtensionsNotice {
  type: "extensions.changed";
}

const readers = new Set<() => void>();

/** Every shown list of extensions and actions reads again: a notice came, or may have been missed. */
export function extensionsNotice() {
  readers.forEach((read) => read());
}

/** A list the kernel keeps, under `key`, read again whenever extensions change. */
function useKernelList<T>(
  path: string,
  key: string,
  kernel: string,
  enabled: boolean,
) {
  const [read, setRead] = useState<{
    kernel: string;
    items?: T[];
    error?: string;
  }>();
  const reload = useCallback(
    async () =>
      enabled
        ? request<Record<string, T[]>>(kernel, path).then(
            (body) => setRead({ kernel, items: body[key] ?? [] }),
            (error: unknown) =>
              setRead((was) => ({
                ...(was?.kernel === kernel ? was : { kernel }),
                error: errorMessage(error),
              })),
          )
        : undefined,
    [kernel, path, key, enabled],
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

/** The workspace's extensions, read again whenever they change. */
export function useExtensions(kernel = kernelUrl(), enabled = true) {
  const { items, ...rest } = useKernelList<Extension>(
    "/extensions",
    "extensions",
    kernel,
    enabled,
  );
  return { extensions: items, ...rest };
}

/** The actions of the enabled extensions, read again whenever extensions change. */
export function useActions(kernel = kernelUrl(), enabled = true) {
  const { items, ...rest } = useKernelList<ExtensionAction>(
    "/actions",
    "actions",
    kernel,
    enabled,
  );
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

/** An extension from a folder on the kernel's computer, in development. */
export const loadExtensionFolder = (folder: string, kernel = kernelUrl()) =>
  changed(request(kernel, "/extensions/folder", { folder }));

/** Runs an action with its input, as people and agents do: its result. */
export const runAction = (
  extension: string,
  name: string,
  input: Record<string, unknown>,
  kernel = kernelUrl(),
) =>
  request<{ result: unknown }>(
    kernel,
    `/ext/${encodeURIComponent(extension)}/${encodeURIComponent(name)}`,
    input,
  ).then(({ result }) => result);
