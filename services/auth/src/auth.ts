import { Database } from "bun:sqlite";
import { timingSafeEqual } from "node:crypto";
import { betterAuth, type BetterAuthOptions } from "better-auth";
import { createKyselyAdapter } from "@better-auth/kysely-adapter";
import { getMigrations } from "better-auth/db/migration";
import { bearer } from "better-auth/plugins";
import { Pool } from "pg";
import { parseConfig, type AuthConfig } from "./config.ts";

export const CONTROL_HEADER = "x-zerolux-auth-service";
export const ENROLL_HEADER = "x-zerolux-auth-enroll";
const forwardedHeaders = [
  "authorization",
  "cookie",
  "content-type",
  "origin",
  "referer",
  "user-agent",
  "sec-fetch-site",
  "sec-fetch-mode",
  "sec-fetch-dest",
  "x-zerolux-client-ip",
];
const routes = new Map([
  ["/api/auth/sign-up/email", "POST"],
  ["/api/auth/sign-in/email", "POST"],
  ["/api/auth/sign-out", "POST"],
  ["/api/auth/get-session", "GET"],
  ["/api/auth/list-sessions", "GET"],
  ["/api/auth/revoke-session", "POST"],
  ["/api/auth/revoke-sessions", "POST"],
  ["/api/auth/revoke-other-sessions", "POST"],
  ["/api/auth/change-password", "POST"],
]);

function json(value: unknown, status = 200) {
  return Response.json(value, {
    status,
    headers: { "cache-control": "no-store" },
  });
}

function matches(actual: string | null, expected: string) {
  if (!actual) return false;
  const a = Buffer.from(actual),
    b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** A bearer request cannot downgrade to another identity in its browser cookies. */
function credentials(input: Headers) {
  const headers = new Headers();
  for (const name of forwardedHeaders) {
    const value = input.get(name);
    if (value !== null) headers.set(name, value);
  }
  if (headers.has("authorization")) headers.delete("cookie");
  return headers;
}

/** The kernel holds its database lease throughout migration and this service's lifetime. */
export async function createAuth(input: AuthConfig) {
  const config = parseConfig(input);
  const database =
    config.database.kind === "sqlite"
      ? new Database(config.database.path, { create: true, strict: true })
      : new Pool({
          connectionString: config.database.url,
          max: 4,
          connectionTimeoutMillis: 5_000,
        });
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    if (database instanceof Database) database.close();
    else await database.end();
  };
  const options = {
    appName: "ZeroLux",
    baseURL: config.base_url,
    basePath: "/api/auth",
    trustedOrigins: config.trusted_origins,
    secret: config.secret,
    database,
    user: { modelName: "auth_user" },
    account: { modelName: "auth_account" },
    verification: { modelName: "auth_verification" },
    session: {
      modelName: "auth_session",
      expiresIn: 60 * 60 * 24 * 7,
      updateAge: 60 * 60 * 24,
      cookieCache: { enabled: false },
    },
    emailAndPassword: { enabled: true },
    plugins: [bearer({ requireSignature: true })],
    advanced: {
      cookiePrefix: `zerolux-${config.instance_id}`,
      useSecureCookies: config.base_url.startsWith("https:"),
      database: { generateId: "uuid" },
      ipAddress: { ipAddressHeaders: ["x-zerolux-client-ip"] },
    },
    rateLimit: {
      enabled: true,
      storage: "database",
      modelName: "auth_rate_limit",
    },
    // Do not send library diagnostics (which may include credentials) to stdout or logs.
    logger: { disabled: true },
    telemetry: { enabled: false },
  } satisfies BetterAuthOptions;
  try {
    if (database instanceof Database) {
      database.exec(
        "PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL;",
      );
    }
    // The library plans migrations but does not transaction-wrap their DDL. Use its
    // public adapter and pass the transaction back to the same migration API. The
    // kernel's database lease serializes startup; failed DDL leaves no partial schema.
    const { kysely, databaseType } = await createKyselyAdapter(options);
    if (!kysely || !databaseType) throw new Error("Unsupported auth database");
    await kysely.transaction().execute(async (transaction) => {
      const migration = await getMigrations({
        ...options,
        database: { db: transaction, type: databaseType },
      });
      if (migration.schemaProblems.length || migration.unsafeChanges.length)
        throw new Error("Unsupported authentication schema");
      await migration.runMigrations();
    });
    const auth = betterAuth(options);
    await auth.$context;
    return {
      close,
      async fetch(request: Request): Promise<Response> {
        if (!matches(request.headers.get(CONTROL_HEADER), config.control_token))
          return json({ error: "Unauthorized" }, 401);
        const origin = request.headers.get("origin");
        if (
          origin !== null &&
          origin !== config.base_url &&
          !config.trusted_origins.includes(origin)
        )
          return json({ error: "Untrusted authentication origin" }, 403);
        const path = new URL(request.url).pathname;
        if (path === "/internal/health" && request.method === "GET")
          return json({ version: 1, instance_id: config.instance_id });
        const headers = credentials(request.headers);
        const authorization = headers.get("authorization");
        if (authorization && !/^Bearer [^\s,]+$/i.test(authorization))
          return json({ error: "Invalid authorization" }, 401);
        try {
          if (path === "/internal/accounts" && request.method === "GET") {
            const context = await auth.$context;
            return json({
              exists: (await context.internalAdapter.countTotalUsers()) > 0,
            });
          }
          if (path === "/internal/session" && request.method === "GET") {
            const found = await auth.api.getSession({
              headers,
              query: { disableCookieCache: true, disableRefresh: true },
            });
            return json(
              found
                ? {
                    subject: found.user.id,
                    session_id: found.session.id,
                    expires_at: found.session.expiresAt.getTime(),
                    name: found.user.name,
                    email: found.user.email,
                  }
                : null,
            );
          }
          const method = routes.get(path);
          if (!method)
            return json({ error: "Unknown authentication endpoint" }, 404);
          if (request.method !== method)
            return json({ error: "Method not allowed" }, 405);
          if (
            path === "/api/auth/sign-up/email" &&
            request.headers.get(ENROLL_HEADER) !== "1"
          )
            return json({ error: "Enrollment is required" }, 403);
          // Reconstruct the public request without trusting forwarded host/proto headers.
          const url = new URL(request.url);
          const body =
            request.method === "GET" ? undefined : await request.arrayBuffer();
          if (body && body.byteLength > 64 * 1024)
            return json({ error: "Authentication request too large" }, 413);
          const response = await auth.handler(
            new Request(
              new URL(url.pathname + url.search, config.base_url).href,
              { method: request.method, headers, body },
            ),
          );
          response.headers.set("cache-control", "no-store");
          return response;
        } catch {
          return json({ error: "Authentication unavailable" }, 503);
        }
      },
    };
  } catch (error) {
    await close();
    throw error;
  }
}
