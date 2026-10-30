import { request } from "./client";
import { isThread, unreadIn } from "./chat";
import type { Approval, Conversation } from "./chat";

/**
 * A workspace of a kernel the account is a member of, at its own base: `<kernel>/w/<id>`, or
 * the kernel itself for an older kernel's one workspace.
 */
export interface ServedWorkspace {
  id: string;
  name: string;
  /** Where its API is: `${base}/api…`, for every call and file. */
  base: string;
  /** The account is its owner. */
  owner: boolean;
}

/** HTTP is supported for a kernel on the owner's own computer, over the LAN; public connections use HTTPS. */
function localAuthHost(host: string) {
  if (host === "localhost" || host === "[::1]") return true;
  if (/^\[(?:f[cd][\da-f]{2}|fe[89ab][\da-f]):/i.test(host)) return true;
  if (!/^\d+(?:\.\d+){3}$/.test(host)) return false;
  const ip = host.split(".").map(Number);
  if (
    ip.length !== 4 ||
    ip.some((part) => !Number.isInteger(part) || part < 0 || part > 255)
  )
    return false;
  const [a, b = 0] = ip;
  return (
    a === 127 ||
    a === 10 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 169 && b === 254)
  );
}

/**
 * A kernel address as a client may use it: the kernel's origin, or a workspace's base on it
 * (`<origin>/w/<id>`), with no credentials, query or other path. Given back as the base.
 */
export function secureKernelAddress(address: string) {
  const value = address || globalThis.location?.origin;
  if (!value) throw new Error("Choose a kernel before signing in");
  const url = new URL(value, globalThis.location?.origin);
  const path = url.pathname.replace(/\/+$/, "");
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !(path === "" || /^\/w\/[^/]+$/.test(path))
  )
    throw new Error(
      "The kernel address must be its origin, or a workspace on it, without credentials",
    );
  if (
    url.protocol !== "https:" &&
    !(url.protocol === "http:" && localAuthHost(url.hostname))
  )
    throw new Error("Use HTTPS for a workspace outside your local network");
  return `${url.origin}${path}`;
}

/** A workspace's base on its kernel. */
export const workspaceBase = (kernel: string, id: string) =>
  `${new URL(kernel).origin}/w/${encodeURIComponent(id)}`;

/** The kernel and, when the address names one, the workspace of an address. */
export function workspaceAddress(address: string) {
  const base = secureKernelAddress(address);
  const url = new URL(base);
  const id = /^\/w\/([^/]+)$/.exec(url.pathname)?.[1];
  return {
    kernel: url.origin,
    workspaceId: id ? decodeURIComponent(id) : undefined,
  };
}

/** The workspace to open on a kernel: the one chosen last if it is still there, else the only one. */
export function pickWorkspace(
  workspaces: ServedWorkspace[],
  remembered?: string,
) {
  return (
    workspaces.find((w) => w.id === remembered) ??
    (workspaces.length === 1 ? workspaces[0] : undefined)
  );
}

const memoryKey = (kernel: string) =>
  `zerolux.workspace.${new URL(kernel).origin}`;

/** The workspace chosen last on an instance, where the client keeps it (a browser's storage). */
export function rememberedWorkspace(kernel: string) {
  try {
    return globalThis.localStorage?.getItem(memoryKey(kernel)) ?? undefined;
  } catch {
    return undefined;
  }
}

export function rememberWorkspace(kernel: string, id: string) {
  try {
    globalThis.localStorage?.setItem(memoryKey(kernel), id);
  } catch {
    // Storage refused, as in a private window: the choice is asked again next time.
  }
}

/**
 * What waits for you in a workspace other than the one open: its requests to decide and its
 * chats with messages you have not read, as a badge and «Elsewhere» say them.
 */
export async function workspaceSummary(base: string, signal?: AbortSignal) {
  const [{ approvals }, { conversations }] = await Promise.all([
    request<{ approvals: Approval[] }>(
      base,
      "/chat/approvals",
      undefined,
      signal,
    ),
    request<{ conversations: Conversation[] }>(
      base,
      "/conversations",
      undefined,
      signal,
    ),
  ]);
  return {
    requests: approvals.filter((a) => a.status === "pending").length,
    // As the Chats badge counts them: chats, not their threads.
    unread: conversations.filter((c) => !isThread(c) && unreadIn(c) > 0).length,
  };
}
