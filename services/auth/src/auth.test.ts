import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Pool } from "pg";
import { createAuth, CONTROL_HEADER, ENROLL_HEADER } from "./auth.ts";
import { authOrigin, parseConfig, type AuthConfig } from "./config.ts";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
const password = "Test-only password, never a personal credential!";

type Backend = "sqlite" | "postgres";
const postgres = process.env.ZEROLUX_TEST_POSTGRES_URL;
const backends: Backend[] = [
  "sqlite",
  ...(postgres ? ["postgres" as const] : []),
];

async function createFixture(backend: Backend) {
  const root = await mkdtemp(join(tmpdir(), "zerolux-auth-"));
  let service: Awaited<ReturnType<typeof createAuth>> | undefined;
  let admin: Pool | undefined;
  let schema: string | undefined;
  cleanups.push(async () => {
    try {
      await service?.close();
    } finally {
      try {
        if (schema) await admin?.query(`DROP SCHEMA "${schema}" CASCADE`);
      } finally {
        await admin?.end();
        await rm(root, { recursive: true, force: true });
      }
    }
  });
  const config: AuthConfig = {
    version: 1,
    workspace_id: randomUUID(),
    database: { kind: "sqlite", path: join(root, "workspace.db") },
    base_url: "http://127.0.0.1:4310",
    trusted_origins: ["tauri://localhost", "http://tauri.localhost"],
    secret: randomBytes(32).toString("hex"),
    control_token: randomBytes(32).toString("hex"),
  };
  if (backend === "postgres") {
    if (!postgres)
      throw new Error("The explicit test PostgreSQL URL is required");
    const url = new URL(postgres);
    const owned = `zerolux_auth_test_${randomUUID().replaceAll("-", "")}`;
    admin = new Pool({
      connectionString: postgres,
      max: 1,
      connectionTimeoutMillis: 5_000,
    });
    await admin.query(`CREATE SCHEMA "${owned}"`);
    schema = owned; // Cleanup only after this fixture successfully created it.
    url.searchParams.set("options", `-c search_path=${owned}`);
    config.database = { kind: "postgres", url: url.href };
  }
  service = await createAuth(config);
  const call = (
    path: string,
    body?: unknown,
    headers: Record<string, string> = {},
    browser = true,
  ) =>
    service!.fetch(
      new Request(`http://127.0.0.1:49152${path}`, {
        method: body === undefined ? "GET" : "POST",
        headers: {
          [CONTROL_HEADER]: config.control_token,
          "x-zerolux-client-ip": "192.0.2.10",
          ...(browser ? { origin: config.base_url } : {}),
          ...(body === undefined ? {} : { "content-type": "application/json" }),
          ...headers,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
    );
  const signup = async (email = "owner@example.test") => {
    const response = await call(
      "/api/auth/sign-up/email",
      { name: "Test owner", email, password },
      { [ENROLL_HEADER]: "1" },
    );
    expect(response.status).toBe(200);
    const token = response.headers.get("set-auth-token")!;
    const cookie = response.headers
      .getSetCookie()
      .map((c) => c.split(";")[0])
      .join("; ");
    const body = (await response.json()) as {
      token: string;
      user: { id: string };
    };
    expect(token).toBeTruthy();
    return {
      token,
      cookie,
      subject: body.user.id,
      rawToken: body.token,
      response,
    };
  };
  return {
    config,
    call,
    signup,
    // Fixture inspection only; no application component reads Better Auth's tables.
    async sql(
      sqlite: string,
      pg = sqlite,
      values: (string | number | Date)[] = [],
    ): Promise<unknown[]> {
      if (config.database.kind === "sqlite") {
        const db = new Database(config.database.path);
        try {
          return db
            .query(sqlite)
            .all(
              ...values.map((v) => (v instanceof Date ? v.toISOString() : v)),
            );
        } finally {
          db.close();
        }
      }
      const pool = new Pool({ connectionString: config.database.url, max: 1 });
      try {
        return (await pool.query(pg, values)).rows;
      } finally {
        await pool.end();
      }
    },
    async stop() {
      await service!.close();
    },
    async restart() {
      await service!.close();
      config.control_token = randomBytes(32).toString("hex");
      service = await createAuth(config);
    },
  };
}

async function identity(
  f: Awaited<ReturnType<typeof createFixture>>,
  headers: Record<string, string>,
) {
  const response = await f.call("/internal/session", undefined, headers);
  expect(response.status).toBe(200);
  return response.json() as Promise<{
    subject: string;
    session_id: string;
    expires_at: number;
  } | null>;
}

describe.each(backends)("%s", (backend) => {
  const fixture = () => createFixture(backend);

  test("a late migration failure rolls back all auth DDL and preserves domain data", async () => {
    const f = await fixture();
    await f.stop();
    const indexes = await f.sql(
      "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'auth_session' AND sql IS NOT NULL",
      "SELECT indexname AS name FROM pg_indexes WHERE schemaname = current_schema() AND tablename = 'auth_session' AND indexdef NOT LIKE '% UNIQUE %'",
    );
    const { name } = indexes[0] as { name: string };
    expect(name).toMatch(/^[a-zA-Z0-9_]+$/);
    const tables = [
      "auth_account",
      "auth_session",
      "auth_user",
      "auth_verification",
      "auth_rate_limit",
    ];
    for (const table of tables) await f.sql(`DROP TABLE "${table}"`);
    await f.sql("CREATE TABLE domain_sentinel (id TEXT PRIMARY KEY)");
    await f.sql("INSERT INTO domain_sentinel VALUES ('keep')");
    // Indexes are created after all tables. A name collision on an unrelated domain
    // table fails that late step in the real library's migration on both databases.
    await f.sql(`CREATE INDEX "${name}" ON domain_sentinel (id)`);
    await expect(f.restart()).rejects.toThrow(/already exists/);
    const remaining = (await f.sql(
      "SELECT name FROM sqlite_master WHERE type = 'table'",
      "SELECT table_name AS name FROM information_schema.tables WHERE table_schema = current_schema()",
    )) as { name: string }[];
    expect(remaining.filter((row) => tables.includes(row.name))).toEqual([]);
    expect(await f.sql("SELECT id FROM domain_sentinel")).toEqual([
      { id: "keep" },
    ]);
    await f.sql(`DROP INDEX "${name}"`);
    await f.restart();
    await f.signup();
  });

  test("an incompatible required auth column is refused rather than announced ready", async () => {
    const f = await fixture();
    await f.stop();
    await f.sql(
      "ALTER TABLE auth_user ADD COLUMN future_required TEXT NOT NULL",
    );
    await expect(f.restart()).rejects.toThrow(
      "Unsupported authentication schema",
    );
    const columns = (await f.sql(
      "PRAGMA table_info(auth_user)",
      "SELECT column_name AS name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'auth_user'",
    )) as { name: string }[];
    expect(columns.some((column) => column.name === "future_required")).toBe(
      true,
    );
  });

  test("the sidecar requires its private credential, and public signup cannot enroll itself", async () => {
    const f = await fixture();
    for (const path of [
      "/internal/health",
      "/internal/session",
      "/api/auth/get-session",
    ])
      expect(
        (await f.call(path, undefined, { [CONTROL_HEADER]: "forged" })).status,
      ).toBe(401);
    expect(
      (
        await f.call("/api/auth/sign-up/email", {
          name: "Attacker",
          email: "attacker@example.test",
          password,
        })
      ).status,
    ).toBe(403);
    expect((await f.call("/internal/health")).status).toBe(200);
    expect((await f.call("/api/auth/not-an-endpoint")).status).toBe(404);
  });

  test("real Better Auth accepts its cookie or signed bearer, never a raw token or bearer fallback", async () => {
    const f = await fixture();
    const user = await f.signup();
    const byCookie = await identity(f, { cookie: user.cookie });
    const byBearer = await identity(f, {
      authorization: `Bearer ${user.token}`,
    });
    expect(byCookie).toEqual(byBearer);
    expect(byCookie?.subject).toBe(user.subject);
    expect(byCookie!.expires_at).toBeGreaterThan(Date.now());
    expect(user.response.headers.get("set-cookie")).toContain("HttpOnly");
    expect(user.cookie).not.toContain("session_data");
    expect(await identity(f, {})).toBeNull();
    expect(
      await identity(f, { authorization: `Bearer ${user.rawToken}` }),
    ).toBeNull();
    expect(
      await identity(f, {
        authorization: "Bearer forged",
        cookie: user.cookie,
      }),
    ).toBeNull();
    expect(
      (
        await f.call("/internal/session", undefined, {
          authorization: `Bearer ${user.token}, Bearer forged`,
        })
      ).status,
    ).toBe(401);
  });

  test("logout immediately revokes both bearer and cookie without a JWT/cache grace period", async () => {
    const f = await fixture();
    const user = await f.signup();
    expect(
      (
        await f.call(
          "/api/auth/sign-out",
          {},
          { authorization: `Bearer ${user.token}` },
        )
      ).status,
    ).toBe(200);
    expect(await identity(f, { cookie: user.cookie })).toBeNull();
    expect(
      await identity(f, { authorization: `Bearer ${user.token}` }),
    ).toBeNull();
  });

  test("native clients can sign in and out with bearer sessions without a browser Origin", async () => {
    const f = await fixture();
    const first = await f.signup();
    const login = await f.call(
      "/api/auth/sign-in/email",
      { email: "owner@example.test", password },
      {},
      false,
    );
    expect(login.status).toBe(200);
    const token = login.headers.get("set-auth-token")!;
    const checked = await f.call(
      "/internal/session",
      undefined,
      { authorization: `Bearer ${token}` },
      false,
    );
    expect(((await checked.json()) as { subject: string }).subject).toBe(
      first.subject,
    );
    expect(
      (
        await f.call(
          "/api/auth/sign-out",
          {},
          { authorization: `Bearer ${token}` },
          false,
        )
      ).status,
    ).toBe(200);
    expect(await identity(f, { authorization: `Bearer ${token}` })).toBeNull();
  });

  test("another session can be revoked without revoking the current session", async () => {
    const f = await fixture();
    const first = await f.signup();
    const signedIn = await f.call("/api/auth/sign-in/email", {
      email: "owner@example.test",
      password,
    });
    expect(signedIn.status).toBe(200);
    const second = signedIn.headers.get("set-auth-token")!;
    expect(second).not.toBe(first.token);
    expect(
      (
        await f.call(
          "/api/auth/revoke-other-sessions",
          {},
          { authorization: `Bearer ${second}` },
        )
      ).status,
    ).toBe(200);
    expect(
      await identity(f, { authorization: `Bearer ${first.token}` }),
    ).toBeNull();
    expect(
      (await identity(f, { authorization: `Bearer ${second}` }))?.subject,
    ).toBe(first.subject);
  });

  test("a service restart preserves identity and valid sessions but replaces the private control credential", async () => {
    const f = await fixture();
    const first = await f.signup();
    const before = await identity(f, { cookie: first.cookie });
    const previousControl = f.config.control_token;
    await f.restart();
    expect(
      (
        await f.call("/internal/health", undefined, {
          [CONTROL_HEADER]: previousControl,
        })
      ).status,
    ).toBe(401);
    expect(await identity(f, { cookie: first.cookie })).toEqual(before);
    expect(
      await identity(f, { authorization: `Bearer ${first.token}` }),
    ).toEqual(before);
  });

  test("workspace cookie names and signing secrets isolate two kernels on the same hostname", async () => {
    const a = await fixture(),
      b = await fixture();
    const alice = await a.signup(),
      bob = await b.signup();
    expect(alice.cookie).toContain(
      `zerolux-${a.config.workspace_id}.session_token`,
    );
    expect(bob.cookie).toContain(
      `zerolux-${b.config.workspace_id}.session_token`,
    );
    expect(await identity(b, { cookie: alice.cookie })).toBeNull();
    expect(
      await identity(b, { authorization: `Bearer ${alice.token}` }),
    ).toBeNull();
    expect(
      (await identity(b, { cookie: `${alice.cookie}; ${bob.cookie}` }))
        ?.subject,
    ).toBe(bob.subject);
  });

  test("private validation never refreshes a session; the public client refresh does", async () => {
    const f = await fixture();
    const { token } = await f.signup();
    const expires = new Date(Date.now() + 5 * 24 * 60 * 60 * 1000);
    await f.sql(
      'UPDATE auth_session SET "expiresAt" = ?',
      'UPDATE auth_session SET "expiresAt" = $1',
      [expires],
    );
    const headers = { authorization: `Bearer ${token}` };
    const before = await identity(f, headers);
    expect(before?.expires_at).toBe(expires.getTime());
    expect((await identity(f, headers))?.expires_at).toBe(expires.getTime());
    expect(
      (await f.call("/api/auth/get-session", undefined, headers)).status,
    ).toBe(200);
    expect((await identity(f, headers))!.expires_at).toBeGreaterThan(
      expires.getTime() + 24 * 60 * 60 * 1000,
    );
  });

  test("an expired session is rejected by the real database lookup", async () => {
    const f = await fixture();
    const first = await f.signup();
    await f.sql(
      'UPDATE auth_session SET "expiresAt"=?',
      'UPDATE auth_session SET "expiresAt"=$1',
      [new Date(Date.now() - 60_000)],
    );
    expect(await identity(f, { cookie: first.cookie })).toBeNull();
  });

  test("an explicitly configured LAN origin can authenticate, but another address in its subnet cannot", async () => {
    const f = await fixture();
    f.config.trusted_origins.push("http://192.168.1.10:4310");
    await f.restart();
    const owner = await f.signup();
    const signed = await f.call(
      "/api/auth/sign-in/email",
      {
        email: "owner@example.test",
        password,
      },
      { origin: "http://192.168.1.10:4310" },
    );
    expect(signed.status).toBe(200);
    expect(signed.headers.get("set-auth-token")).toBeTruthy();
    const other = await f.call("/api/auth/get-session", undefined, {
      cookie: owner.cookie,
      origin: "http://192.168.1.11:4310",
    });
    expect(other.status).toBe(403);
  });

  test("origin protections remain enabled; the private channel does not authorize hostile browser origins", async () => {
    const f = await fixture();
    expect(
      (
        await f.call(
          "/api/auth/sign-up/email",
          { name: "Test", email: "owner@example.test", password },
          {
            [ENROLL_HEADER]: "1",
            origin: "https://attacker.example",
          },
        )
      ).status,
    ).toBe(403);
    const owner = await f.signup();
    expect(
      (
        await f.call(
          "/api/auth/sign-out",
          {},
          { cookie: owner.cookie, origin: "https://attacker.example" },
        )
      ).status,
    ).toBe(403);
    expect((await identity(f, { cookie: owner.cookie }))?.subject).toBe(
      owner.subject,
    );
  });

  test("changing a password can revoke other sessions and reject the former password", async () => {
    const f = await fixture();
    const first = await f.signup();
    const login = await f.call("/api/auth/sign-in/email", {
      email: "owner@example.test",
      password,
    });
    const second = login.headers.get("set-auth-token")!;
    expect(
      (
        await f.call(
          "/api/auth/change-password",
          {
            currentPassword: password,
            newPassword: password + " changed",
            revokeOtherSessions: true,
          },
          { authorization: `Bearer ${second}` },
        )
      ).status,
    ).toBe(200);
    expect(
      await identity(f, { authorization: `Bearer ${first.token}` }),
    ).toBeNull();
    expect(
      (
        await f.call("/api/auth/sign-in/email", {
          email: "owner@example.test",
          password,
        })
      ).status,
    ).toBe(401);
    expect(
      (
        await f.call("/api/auth/sign-in/email", {
          email: "owner@example.test",
          password: password + " changed",
        })
      ).status,
    ).toBe(200);
  });

  test("auth migrates only its own tables and does not rewrite domain data", async () => {
    const f = await fixture();
    await f.sql(
      "CREATE TABLE domain_sentinel (id TEXT PRIMARY KEY, body TEXT NOT NULL)",
    );
    await f.sql(
      "INSERT INTO domain_sentinel VALUES (?, ?)",
      "INSERT INTO domain_sentinel VALUES ($1, $2)",
      ["same-id", "same history"],
    );
    await f.restart();
    expect(await f.sql("SELECT * FROM domain_sentinel")).toEqual([
      { id: "same-id", body: "same history" },
    ]);
  });

  test("configuration rejects plaintext remote origins, wildcards, paths and relative SQLite files", async () => {
    for (const origin of [
      "http://192.0.2.10:4310",
      "https://example.test/path",
      "https://*.example.test",
      "https://user:password@example.test",
    ])
      expect(() => authOrigin(origin)).toThrow();
    expect(authOrigin("http://127.0.0.1:4310")).toBe("http://127.0.0.1:4310");
    expect(authOrigin("https://company.example/")).toBe(
      "https://company.example",
    );
    expect(authOrigin("tauri://localhost", true)).toBe("tauri://localhost");
    const f = await fixture();
    expect(() =>
      parseConfig({
        ...f.config,
        database: { kind: "sqlite", path: "personal.db" },
      }),
    ).toThrow();
    expect(() =>
      parseConfig({ ...f.config, control_token: f.config.secret }),
    ).toThrow();
  });
});
