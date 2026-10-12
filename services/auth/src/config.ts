import { isAbsolute } from "node:path";

export interface AuthConfig {
  version: 1;
  workspace_id: string;
  database:
    | { kind: "sqlite"; path: string }
    | { kind: "postgres"; url: string };
  base_url: string;
  trusted_origins: string[];
  secret: string;
  control_token: string;
}

const desktopOrigins = new Set(["tauri://localhost", "http://tauri.localhost"]);

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

/** A configured origin, not a subnet allowlist: the handler still matches Origins exactly. */
export function authOrigin(value: string, desktop = false): string {
  if (desktop && desktopOrigins.has(value)) return value;
  const url = new URL(value);
  if (
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash ||
    value.includes("*") ||
    !(
      url.protocol === "https:" ||
      (url.protocol === "http:" && localAuthHost(url.hostname))
    )
  )
    throw new Error(
      "Authentication requires HTTPS or a loopback/LAN HTTP origin",
    );
  return url.origin;
}

/** Only startup configuration, never a caller-supplied request body. */
export function parseConfig(value: unknown): AuthConfig {
  if (!value || typeof value !== "object")
    throw new Error("Invalid auth configuration");
  const c = value as Partial<AuthConfig>;
  if (
    c.version !== 1 ||
    typeof c.workspace_id !== "string" ||
    !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(c.workspace_id) ||
    typeof c.secret !== "string" ||
    c.secret.length < 32 ||
    typeof c.control_token !== "string" ||
    c.control_token.length < 32 ||
    c.secret === c.control_token ||
    typeof c.base_url !== "string" ||
    !Array.isArray(c.trusted_origins) ||
    c.trusted_origins.some((origin) => typeof origin !== "string") ||
    !c.database
  )
    throw new Error("Invalid auth configuration");
  if (c.database.kind === "sqlite") {
    if (typeof c.database.path !== "string" || !isAbsolute(c.database.path))
      throw new Error("Authentication requires an absolute SQLite path");
  } else if (c.database.kind === "postgres") {
    const url = new URL(c.database.url);
    if (!["postgres:", "postgresql:"].includes(url.protocol) || !url.hostname)
      throw new Error("Invalid authentication database URL");
  } else throw new Error("Unsupported authentication database");
  return {
    ...(c as AuthConfig),
    base_url: authOrigin(c.base_url),
    trusted_origins: [
      ...new Set(c.trusted_origins.map((origin) => authOrigin(origin, true))),
    ],
  };
}
