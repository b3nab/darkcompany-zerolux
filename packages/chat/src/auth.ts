import { ApiError, fetchKernel } from "./client";
import {
  authenticationRequired,
  bindCredential,
  clearCredential,
  type RequestCredential,
} from "./credentials";

export interface AuthIdentity {
  user: { id: string; name: string; email: string };
  actor_id: string | null;
  /** The workspace's owner, who set it up; a person who joined by invitation is not. */
  owner: boolean;
  setup_required: boolean;
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
  workspace: { id: string; name: string };
  auth: { setup_required: boolean };
}
/** Supplied only by native clients. Browser sessions stay in HttpOnly cookies. */
export interface AuthStorage {
  read(kernel: string, workspaceId: string): Promise<string | null>;
  write(
    kernel: string,
    workspaceId: string,
    token: string | null,
  ): Promise<void>;
}

/** A collision-free, SecureStore-compatible key, including BOTH address and workspace identity. */
export function credentialStorageKey(kernel: string, workspaceId: string) {
  const address = Array.from(kernel, (c) =>
    c.codePointAt(0)!.toString(16).padStart(6, "0"),
  ).join("");
  return `zerolux.auth.${workspaceId}.${address}`;
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

export function secureKernelOrigin(kernel: string) {
  const value = kernel || globalThis.location?.origin;
  if (!value) throw new Error("Choose a kernel before signing in");
  const url = new URL(value);
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/"
  )
    throw new Error(
      "The kernel address must be an origin without credentials or a path",
    );
  if (
    url.protocol !== "https:" &&
    !(url.protocol === "http:" && localAuthHost(url.hostname))
  )
    throw new Error("Use HTTPS for a workspace outside your local network");
  return url.origin;
}

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

/** Public discovery only: never reads storage, sends credentials or follows redirects. */
export async function probeKernel(kernel: string): Promise<AuthHealth> {
  secureKernelOrigin(kernel);
  const { response, value } = await authRequest(
    `${kernel.replace(/\/+$/, "")}/api/health`,
    {
      credentials: "omit",
      redirect: "error",
    },
  );
  if (!response.ok)
    throw new ApiError("The kernel could not be verified", response.status);
  const health = value as AuthHealth | null;
  if (
    !health ||
    !Array.isArray(health.capabilities) ||
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
  return health.capabilities.includes("auth-v1");
}

/** One verified kernel connection, not a global login that can follow arbitrary addresses. */
export class AuthConnection {
  readonly kernel: string;
  private credential?: RequestCredential;
  private health?: AuthHealth;
  private workspaceId?: string;
  private epoch = 0;
  private writes: Promise<void> = Promise.resolve();

  constructor(
    kernel: string,
    private readonly expectedWorkspaceId?: string,
    private readonly storage?: AuthStorage,
  ) {
    this.kernel = kernel.replace(/\/+$/, "");
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

  private async remember(token: string | null, epoch: number) {
    this.current(epoch);
    const health = this.health;
    if (!health) throw new Error("The workspace has not been verified");
    if (this.storage) {
      // Serialize native-store writes: a slow old login cannot overwrite a newer logout.
      const write = this.writes
        .catch(() => {})
        .then(async () => {
          this.current(epoch);
          await this.storage!.write(this.kernel, health.workspace.id, token);
        });
      this.writes = write;
      await write;
      this.current(epoch);
    }
    this.credential = bindCredential(
      this.kernel,
      health.workspace.id,
      token,
      Boolean(this.storage),
    );
  }

  private async exchange<T>(
    path: string,
    method: "GET" | "POST",
    body?: unknown,
    epoch = this.epoch,
    headers: Record<string, string> = {},
  ): Promise<T> {
    this.current(epoch);
    const { response, value } = await authRequest(
      `${this.kernel}/api/auth${path}`,
      {
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
      },
    );
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
      ["/sign-in/email", "/sign-up/email"].includes(path) &&
      !token
    )
      throw new Error("The kernel did not return a native session credential");
    if (this.storage && token) await this.remember(token, epoch);
    return value as T;
  }

  /** Probe without any credential, before reading or sending a saved native token. */
  async restore(): Promise<{
    health: AuthHealth;
    identity: AuthIdentity | null;
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
    if (
      this.expectedWorkspaceId &&
      health.workspace.id !== this.expectedWorkspaceId
    )
      this.refuse(
        "This address now serves a different workspace; no credentials were sent",
      );
    if (this.workspaceId && health.workspace.id !== this.workspaceId)
      this.refuse("The workspace identity changed; no credentials were sent");
    this.workspaceId = health.workspace.id;
    this.health = health;
    if (!requiresSignIn(health)) {
      this.credential = bindCredential(
        this.kernel,
        health.workspace.id,
        null,
        false,
      );
      return { health, identity: null };
    }
    const token = this.storage
      ? await this.storage.read(this.kernel, health.workspace.id)
      : null;
    this.current(epoch);
    this.credential = bindCredential(
      this.kernel,
      health.workspace.id,
      token,
      Boolean(this.storage),
    );
    if (this.storage && !token) return { health, identity: null };
    try {
      const session = await this.exchange<unknown>(
        "/get-session",
        "GET",
        undefined,
        epoch,
      );
      if (session)
        return {
          health,
          identity: await this.exchange<AuthIdentity>(
            "/identity",
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

  async signIn(email: string, password: string): Promise<AuthIdentity> {
    if (!this.health) throw new Error("Verify the workspace before signing in");
    const epoch = ++this.epoch;
    await this.exchange(
      "/sign-in/email",
      "POST",
      { email: email.trim(), password },
      epoch,
    );
    return this.exchange<AuthIdentity>("/identity", "GET", undefined, epoch);
  }

  /** An invitation, read with no account: refused (410) once used, withdrawn or expired. */
  async invitation(token: string): Promise<Invitation> {
    const { invitation } = await this.exchange<{ invitation: Invitation }>(
      `/invites/${encodeURIComponent(token)}`,
      "GET",
    );
    return invitation;
  }

  /**
   * A new account: the owner's, while the workspace has none, or a person's who joins with
   * an invitation.
   */
  async signUp(
    name: string,
    email: string,
    password: string,
    invite?: string,
  ): Promise<AuthIdentity> {
    if (!this.health) throw new Error("Verify the workspace before signing up");
    const epoch = ++this.epoch;
    await this.exchange(
      "/sign-up/email",
      "POST",
      { name: name.trim(), email: email.trim(), password },
      epoch,
      invite ? { "x-zerolux-invite": invite } : {},
    );
    // Signup and binding are separate: a failed claim can be retried after signing in.
    return this.claim(invite);
  }

  /** Binds the signed-in account: to the owner, or with an invitation to a new person. */
  async claim(invite?: string): Promise<AuthIdentity> {
    if (!this.health) throw new Error("Verify the workspace before enrollment");
    const epoch = ++this.epoch;
    const identity = await this.exchange<AuthIdentity>(
      "/claim",
      "POST",
      invite ? { invite } : undefined,
      epoch,
    );
    this.health.auth.setup_required = identity.setup_required;
    return identity;
  }

  async signOut(): Promise<void> {
    if (!this.health)
      throw new Error("Verify the workspace before signing out");
    const epoch = ++this.epoch;
    try {
      await this.exchange("/sign-out", "POST", {}, epoch);
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
    await this.exchange("/change-password", "POST", {
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
      this.exchange<AuthDevice[]>("/list-sessions", "GET"),
      this.exchange<{ session: { id: string } } | null>("/get-session", "GET"),
    ]);
    return { devices, current: current?.session.id ?? null };
  }

  /** Signs one of your other devices out. */
  async signOutDevice(token: string): Promise<void> {
    await this.exchange("/revoke-session", "POST", { token });
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
