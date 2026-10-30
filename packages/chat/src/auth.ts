import { ApiError, fetchKernel } from "./client";
import { secureKernelAddress, workspaceBase } from "./instance";
import type { ServedWorkspace } from "./instance";
import {
  authenticationRequired,
  bindCredential,
  clearCredential,
  kernelOrigin,
  type RequestCredential,
} from "./credentials";

/** The signed-in account, on its kernel. */
export interface AccountIdentity {
  user: { id: string; name: string; email: string };
  /** The kernel has no account yet; on an older kernel, its workspace has no owner yet. */
  setup_required: boolean;
}
/** The account in one workspace: the person it is there, if it is one yet. */
export interface AuthIdentity extends AccountIdentity {
  actor_id: string | null;
  /** The workspace's owner, who set it up; a person who joined by invitation is not. */
  owner: boolean;
}
/** What an invitation says before one signs up with it. */
export interface Invitation {
  workspace: string;
  invited_by: string;
  expires_at: number;
}
/** A device signed in as you: a browser, the desktop app or the phone. */
export interface AuthDevice {
  id: string;
  token: string;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
  ipAddress?: string | null;
  userAgent?: string | null;
}
export interface AuthHealth {
  api_version: number;
  capabilities: string[];
  /** A kernel with one sign-in for all its workspaces: the instance its accounts belong to. */
  instance?: { id: string };
  /** An older kernel's one workspace, at its origin, with the kernel's sign-in. */
  workspace?: { id: string; name: string };
  auth: { setup_required: boolean };
}
/** Supplied only by native clients. Browser sessions stay in HttpOnly cookies. */
export interface AuthStorage {
  read(kernel: string): Promise<string | null>;
  write(kernel: string, token: string | null): Promise<void>;
}

/**
 * A collision-free, SecureStore-compatible key for a kernel's sign-in, by its origin. With a
 * workspace's id, the key its own sign-in had before a kernel signed in once for all its
 * workspaces: read once, to keep that sign-in.
 */
export function credentialStorageKey(kernel: string, workspaceId?: string) {
  const address = Array.from(new URL(kernel).origin, (c) =>
    c.codePointAt(0)!.toString(16).padStart(6, "0"),
  ).join("");
  return workspaceId
    ? `zerolux.auth.${workspaceId}.${address}`
    : `zerolux.auth.${address}`;
}

/** The kernel signs in once for all its workspaces, lists them per account and creates them. */
export const multiWorkspace = (health: AuthHealth) =>
  health.capabilities.includes("instance-auth-v1");

/**
 * What a saved sign-in belongs to: the instance, or an older kernel's one workspace. A client
 * keeps it with the sign-in and sends that only to the same identity.
 */
export const kernelId = (health: AuthHealth) =>
  health.instance?.id ?? health.workspace!.id;

async function authRequest(url: string, init: RequestInit) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const response = await fetchKernel(url, {
      ...init,
      cache: "no-store",
      signal: controller.signal,
    });
    const value: unknown = await response.json();
    return { response, value };
  } catch (error) {
    if (controller.signal.aborted)
      throw new Error("Authentication request timed out");
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

class AuthProtocolError extends Error {}

/**
 * Public discovery only, at the kernel's root: never reads storage, sends credentials or
 * follows redirects.
 */
export async function probeKernel(address: string): Promise<AuthHealth> {
  const kernel = kernelOrigin(secureKernelAddress(address));
  const { response, value } = await authRequest(`${kernel}/api/health`, {
    credentials: "omit",
    redirect: "error",
  });
  if (!response.ok)
    throw new ApiError("The kernel could not be verified", response.status);
  const health = value as AuthHealth | null;
  if (!health || !Array.isArray(health.capabilities))
    throw new AuthProtocolError("This is not a ZeroLux kernel");
  if (multiWorkspace(health)) {
    if (
      typeof health.instance?.id !== "string" ||
      !health.instance.id ||
      typeof health.auth?.setup_required !== "boolean"
    )
      throw new AuthProtocolError("This kernel's sign-in is not understood");
    return health;
  }
  // The first kernels with several workspaces signed in to each apart: they are updated instead.
  if (health.capabilities.includes("workspaces-v1"))
    throw new AuthProtocolError("Update this kernel to connect to it");
  if (
    typeof health.workspace?.id !== "string" ||
    !health.workspace.id ||
    typeof health.workspace.name !== "string"
  )
    throw new AuthProtocolError("This is not a ZeroLux kernel");
  // A kernel without sign-in: its version is what it is, the client works as it did.
  if (!health.capabilities.includes("auth-v1"))
    return { ...health, auth: { setup_required: false } };
  if (typeof health.auth?.setup_required !== "boolean")
    throw new AuthProtocolError("This kernel's sign-in is not understood");
  return health;
}

/** Whether a kernel asks people to sign in at all. */
export function requiresSignIn(health: AuthHealth) {
  return multiWorkspace(health) || health.capabilities.includes("auth-v1");
}

/** A workspace as the kernel lists it, at its base there. */
function served(kernel: string, value: unknown): ServedWorkspace {
  const w = value as {
    id?: unknown;
    name?: unknown;
    owner?: unknown;
  } | null;
  if (
    typeof w?.id !== "string" ||
    !w.id ||
    typeof w.name !== "string" ||
    typeof w.owner !== "boolean"
  )
    throw new AuthProtocolError("This kernel's workspaces are not understood");
  return {
    id: w.id,
    name: w.name,
    base: workspaceBase(kernel, w.id),
    owner: w.owner,
  };
}

/**
 * One verified kernel and its one sign-in, for all its workspaces: never a login that
 * follows other addresses.
 */
export class AuthConnection {
  /** The kernel's origin. */
  readonly kernel: string;
  private credential?: RequestCredential;
  private health?: AuthHealth;
  private id?: string;
  private epoch = 0;
  private writes: Promise<void> = Promise.resolve();

  /** `expected` is the kernel's id saved with its sign-in (`kernelId`). */
  constructor(
    address: string,
    private readonly expected?: string,
    private readonly storage?: AuthStorage,
  ) {
    this.kernel = kernelOrigin(address);
  }

  private current(epoch: number) {
    if (epoch !== this.epoch) {
      const error = new Error("Authentication changed");
      error.name = "AbortError";
      throw error;
    }
  }

  private refuse(message: string): never {
    this.health = undefined;
    if (this.credential) clearCredential(this.kernel, this.credential);
    this.credential = undefined;
    throw new Error(message);
  }

  private verified() {
    if (!this.health) throw new Error("Verify the kernel first");
    return this.health;
  }

  /** A workspace's base on this kernel: a credential never goes to another one. */
  private within(base: string) {
    const address = secureKernelAddress(base);
    if (kernelOrigin(address) !== this.kernel)
      throw new Error("That workspace is on another kernel");
    return address;
  }

  private async remember(token: string | null, epoch: number) {
    this.current(epoch);
    this.verified();
    if (this.storage) {
      // Serialize native-store writes: a slow old login cannot overwrite a newer logout.
      const write = this.writes
        .catch(() => {})
        .then(async () => {
          this.current(epoch);
          await this.storage!.write(this.kernel, token);
        });
      this.writes = write;
      await write;
      this.current(epoch);
    }
    this.credential = bindCredential(this.kernel, token, Boolean(this.storage));
  }

  /** A call under `${at}/api`, with this kernel's sign-in. */
  private async exchange<T>(
    path: string,
    method: "GET" | "POST",
    body?: unknown,
    epoch = this.epoch,
    headers: Record<string, string> = {},
    at = this.kernel,
  ): Promise<T> {
    this.current(epoch);
    const { response, value } = await authRequest(`${at}/api${path}`, {
      method,
      credentials: this.storage ? "omit" : "same-origin",
      redirect: "error",
      headers: {
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        ...(this.credential?.token
          ? { Authorization: `Bearer ${this.credential.token}` }
          : {}),
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    this.current(epoch);
    if (!response.ok) {
      const error = value as { error?: string; message?: string } | null;
      throw new ApiError(
        error?.error ??
          error?.message ??
          `Authentication failed (${response.status})`,
        response.status,
      );
    }
    const token = response.headers.get("set-auth-token");
    if (
      this.storage &&
      ["/auth/sign-in/email", "/auth/sign-up/email"].includes(path) &&
      !token
    )
      throw new Error("The kernel did not return a native session credential");
    if (this.storage && token) await this.remember(token, epoch);
    return value as T;
  }

  /** Probe without any credential, before reading or sending a saved native token. */
  async restore(): Promise<{
    health: AuthHealth;
    identity: AccountIdentity | null;
  }> {
    const epoch = ++this.epoch;
    let health: AuthHealth;
    try {
      health = await probeKernel(this.kernel);
    } catch (error) {
      this.current(epoch);
      if (error instanceof AuthProtocolError) this.refuse(error.message);
      throw error;
    }
    this.current(epoch);
    const id = kernelId(health);
    if (this.expected && id !== this.expected)
      this.refuse(
        "This address now serves a different kernel; no credentials were sent",
      );
    if (this.id && id !== this.id)
      this.refuse("The kernel's identity changed; no credentials were sent");
    this.id = id;
    this.health = health;
    if (!requiresSignIn(health)) {
      this.credential = bindCredential(this.kernel, null, false);
      return { health, identity: null };
    }
    const token = this.storage ? await this.storage.read(this.kernel) : null;
    this.current(epoch);
    this.credential = bindCredential(this.kernel, token, Boolean(this.storage));
    if (this.storage && !token) return { health, identity: null };
    try {
      const session = await this.exchange<unknown>(
        "/auth/get-session",
        "GET",
        undefined,
        epoch,
      );
      if (session)
        return {
          health,
          identity: await this.exchange<AccountIdentity>(
            "/auth/identity",
            "GET",
            undefined,
            epoch,
          ),
        };
    } catch (error) {
      if (!(error instanceof ApiError && error.status === 401)) throw error;
    }
    await this.remember(null, epoch);
    return { health, identity: null };
  }

  async signIn(email: string, password: string): Promise<AccountIdentity> {
    this.verified();
    const epoch = ++this.epoch;
    await this.exchange(
      "/auth/sign-in/email",
      "POST",
      { email: email.trim(), password },
      epoch,
    );
    return this.exchange<AccountIdentity>(
      "/auth/identity",
      "GET",
      undefined,
      epoch,
    );
  }

  /**
   * A new account: the kernel's first, while it has none (on an older kernel, its workspace's
   * owner), or a person's who joins with an invitation. It joins with `claim`.
   */
  async signUp(
    name: string,
    email: string,
    password: string,
    invite?: string,
  ): Promise<AccountIdentity> {
    this.verified();
    const epoch = ++this.epoch;
    await this.exchange(
      "/auth/sign-up/email",
      "POST",
      { name: name.trim(), email: email.trim(), password },
      epoch,
      invite ? { "x-zerolux-invite": invite } : {},
    );
    return this.exchange<AccountIdentity>(
      "/auth/identity",
      "GET",
      undefined,
      epoch,
    );
  }

  /** Who the signed-in account is in a workspace of this kernel. */
  async identity(base: string): Promise<AuthIdentity> {
    this.verified();
    return this.exchange<AuthIdentity>(
      "/auth/identity",
      "GET",
      undefined,
      this.epoch,
      {},
      this.within(base),
    );
  }

  /**
   * Makes the signed-in account a person of a workspace: with an invitation, a new member; on
   * an older kernel without one, the owner it was set up for.
   */
  async claim(base: string, invite?: string): Promise<AuthIdentity> {
    const health = this.verified();
    const epoch = ++this.epoch;
    const identity = await this.exchange<AuthIdentity>(
      "/auth/claim",
      "POST",
      invite ? { invite } : undefined,
      epoch,
      {},
      this.within(base),
    );
    if (!multiWorkspace(health))
      health.auth.setup_required = identity.setup_required;
    return identity;
  }

  /** An invitation to a workspace, read with no account: refused (410) once used, withdrawn or expired. */
  async invitation(base: string, token: string): Promise<Invitation> {
    this.verified();
    const { invitation } = await this.exchange<{ invitation: Invitation }>(
      `/auth/invites/${encodeURIComponent(token)}`,
      "GET",
      undefined,
      this.epoch,
      {},
      this.within(base),
    );
    return invitation;
  }

  /** The workspaces the account is a member of, the oldest first; an older kernel's one. */
  async workspaces(): Promise<ServedWorkspace[]> {
    const health = this.verified();
    if (!multiWorkspace(health)) {
      const owner =
        !requiresSignIn(health) || (await this.identity(this.kernel)).owner;
      return [
        {
          id: health.workspace!.id,
          name: health.workspace!.name,
          base: this.kernel,
          owner,
        },
      ];
    }
    const { workspaces } = await this.exchange<{ workspaces: unknown }>(
      "/workspaces",
      "GET",
    );
    if (!Array.isArray(workspaces))
      throw new AuthProtocolError(
        "This kernel's workspaces are not understood",
      );
    return workspaces.map((w) => served(this.kernel, w));
  }

  /** A new workspace, the account its owner; `folder` is on the kernel's computer. */
  async createWorkspace(
    name: string,
    folder?: string,
  ): Promise<ServedWorkspace> {
    if (!multiWorkspace(this.verified()))
      throw new Error("This kernel serves one workspace");
    const { workspace } = await this.exchange<{ workspace: unknown }>(
      "/workspaces",
      "POST",
      { name: name.trim(), ...(folder ? { folder } : {}) },
    );
    return served(this.kernel, workspace);
  }

  /** Signs this device out of the kernel, and so of all its workspaces. */
  async signOut(): Promise<void> {
    this.verified();
    const epoch = ++this.epoch;
    try {
      await this.exchange("/auth/sign-out", "POST", {}, epoch);
    } catch (error) {
      if (!(error instanceof ApiError && error.status === 401)) throw error;
    }
    await this.remember(null, epoch);
    clearCredential(this.kernel, this.credential);
    this.credential = undefined;
  }

  /** Changes your password; with `signOutOthers` every other device has to sign in again. */
  async changePassword(
    currentPassword: string,
    newPassword: string,
    signOutOthers: boolean,
  ): Promise<void> {
    await this.exchange("/auth/change-password", "POST", {
      currentPassword,
      newPassword,
      revokeOtherSessions: signOutOthers,
    });
  }

  /**
   * The devices signed in as you, and which one is this. Listing them needs a sign-in from
   * the last day: an older one is refused with 403 until you sign in again.
   */
  async devices(): Promise<{ devices: AuthDevice[]; current: string | null }> {
    const [devices, current] = await Promise.all([
      this.exchange<AuthDevice[]>("/auth/list-sessions", "GET"),
      this.exchange<{ session: { id: string } } | null>(
        "/auth/get-session",
        "GET",
      ),
    ]);
    return { devices, current: current?.session.id ?? null };
  }

  /** Signs one of your other devices out. */
  async signOutDevice(token: string): Promise<void> {
    await this.exchange("/auth/revoke-session", "POST", { token });
  }

  onRequired(listener: () => void) {
    return authenticationRequired(this.kernel, listener);
  }

  dispose() {
    ++this.epoch;
    if (this.credential) clearCredential(this.kernel, this.credential);
    this.credential = undefined;
  }
}
