import { afterEach, expect, test } from "bun:test";
import {
  AuthConnection,
  credentialStorageKey,
  secureKernelOrigin,
  probeKernel,
  type AuthStorage,
} from "./auth";
import { request, setKernelFetch } from "./client";
import { bindCredential, clearCredential } from "./credentials";

const originalFetch = globalThis.fetch;
const clients: AuthConnection[] = [];
afterEach(() => {
  for (const client of clients.splice(0)) client.dispose();
  for (const origin of ["https://company.example", "https://other.example"])
    clearCredential(origin);
  globalThis.fetch = originalFetch;
  setKernelFetch();
});

function fixture(
  native = true,
  expected = "workspace-a",
  kernel = "https://company.example",
) {
  const saved = new Map<string, string>();
  const reads: string[] = [];
  const calls: { url: string; init: RequestInit }[] = [];
  const state = {
    workspace: "workspace-a",
    signed: false,
    bound: false,
    setup: true,
    unavailable: false,
    nativeHeader: true,
    identityUnauthorized: false,
    claimUnavailable: false,
    legacy: false,
  };
  const storage: AuthStorage = {
    async read(kernel, id) {
      const key = credentialStorageKey(kernel, id);
      reads.push(key);
      return saved.get(key) ?? null;
    },
    async write(kernel, id, token) {
      const key = credentialStorageKey(kernel, id);
      if (token) saved.set(key, token);
      else saved.delete(key);
    },
  };
  const identity = () => ({
    user: { id: "auth-subject", name: "Owner", email: "owner@example.test" },
    actor_id: state.bound ? "existing-owner" : null,
    setup_required: state.setup,
  });
  globalThis.fetch = (async (url: string, init: RequestInit = {}) => {
    calls.push({ url, init });
    const path = new URL(url).pathname;
    if (state.unavailable)
      return Response.json({ error: "Unavailable" }, { status: 503 });
    if (path === "/api/health")
      return state.legacy
        ? Response.json({
            api_version: 1,
            capabilities: ["chat-v1"],
            workspace: { id: state.workspace, name: "Company" },
          })
        : Response.json({
            api_version: 2,
            capabilities: ["auth-v1", "chat-v1"],
            workspace: { id: state.workspace, name: "Company" },
            auth: { setup_required: state.setup },
          });
    if (path === "/api/auth/get-session")
      return Response.json(
        state.signed ? { session: { id: "session" } } : null,
      );
    if (path === "/api/auth/identity")
      return state.identityUnauthorized
        ? Response.json({ error: "Unauthorized" }, { status: 401 })
        : Response.json(identity());
    if (path === "/api/auth/sign-up/email" && !state.setup)
      return Response.json({ error: "Sign in instead" }, { status: 403 });
    if (["/api/auth/sign-in/email", "/api/auth/sign-up/email"].includes(path)) {
      state.signed = true;
      return Response.json(
        { token: "raw-not-for-native-storage" },
        {
          headers: state.nativeHeader
            ? { "set-auth-token": "signed.session" }
            : {},
        },
      );
    }
    if (path === "/api/auth/claim") {
      if (state.claimUnavailable)
        return Response.json({ error: "Unavailable" }, { status: 503 });
      if (!state.signed)
        return Response.json({ error: "Unauthorized" }, { status: 401 });
      if (!state.setup)
        return Response.json({ error: "Owner already bound" }, { status: 403 });
      state.bound = true;
      state.setup = false;
      return Response.json(identity());
    }
    if (path === "/api/auth/list-sessions")
      return Response.json([
        { id: "session", token: "this-token", userAgent: "Safari" },
        { id: "other", token: "other-token", userAgent: "Chrome" },
      ]);
    if (path === "/api/auth/sign-out") {
      state.signed = false;
      return Response.json({ success: true });
    }
    return Response.json({ ok: true });
  }) as unknown as typeof fetch;
  const client = new AuthConnection(
    kernel,
    expected,
    native ? storage : undefined,
  );
  clients.push(client);
  return { client, state, calls, saved, reads, storage };
}

test("a native connection verifies workspace identity before loading or sending any credential", async () => {
  const f = fixture();
  f.saved.set(
    credentialStorageKey("https://company.example", "workspace-a"),
    "saved.session",
  );
  f.state.signed = true;
  await f.client.restore();
  expect(f.calls[0]!.url).toBe("https://company.example/api/health");
  expect(f.calls[0]!.init.credentials).toBe("omit");
  expect(f.calls[0]!.init.headers).toBeUndefined();
  expect(f.reads).toHaveLength(1);
  expect(new Headers(f.calls[1]!.init.headers).get("authorization")).toBe(
    "Bearer saved.session",
  );
});

test("a reused address serving another workspace never receives the saved credential", async () => {
  const f = fixture();
  f.saved.set(
    credentialStorageKey("https://company.example", "workspace-a"),
    "saved.session",
  );
  f.state.workspace = "workspace-b";
  await expect(f.client.restore()).rejects.toThrow();
  expect(f.reads).toHaveLength(0);
  expect(f.calls).toHaveLength(1);
  expect(f.calls[0]!.init.credentials).toBe("omit");
});

test("a changed workspace disconnects an active credential and cannot accept a subsequent password", async () => {
  const f = fixture(true, ""); // Even a connection without an externally supplied expected ID pins its first identity.
  await f.client.restore();
  await f.client.signIn("owner@example.test", "fixture password");
  f.state.workspace = "workspace-b";
  for (let i = 0; i < 2; i++)
    await expect(f.client.restore()).rejects.toThrow();
  const count = f.calls.length;
  await expect(
    f.client.signIn("owner@example.test", "do not send this"),
  ).rejects.toThrow();
  await expect(
    f.client.signUp("Owner", "owner@example.test", "do not send this"),
  ).rejects.toThrow();
  expect(f.calls).toHaveLength(count);
  await request("https://company.example", "/workspace");
  expect(new Headers(f.calls.at(-1)!.init.headers).has("authorization")).toBe(
    false,
  );
  expect(f.calls.at(-1)!.init.credentials).toBe("omit");
});

test("revocation between get-session and identity forgets the expired native credential", async () => {
  const f = fixture();
  await f.client.restore();
  await f.client.signIn("owner@example.test", "fixture password");
  f.state.identityUnauthorized = true;
  expect((await f.client.restore()).identity).toBeNull();
  expect(f.saved.size).toBe(0);
  await request("https://company.example", "/workspace");
  expect(new Headers(f.calls.at(-1)!.init.headers).has("authorization")).toBe(
    false,
  );
});

test("the selected native transport carries auth and domain requests with no redirects or cookies", async () => {
  const f = fixture();
  const nativeFetch = globalThis.fetch;
  setKernelFetch((url, init) => nativeFetch(url, init));
  globalThis.fetch = (() => {
    throw new Error("The RN/XHR compatibility transport must not be used");
  }) as unknown as typeof fetch;
  await probeKernel("https://company.example");
  await f.client.restore();
  await f.client.signIn("owner@example.test", "fixture password");
  await request("https://company.example", "/workspace");
  expect(
    f.calls.every(
      (c) => c.init.redirect === "error" && c.init.credentials === "omit",
    ),
  ).toBe(true);
  expect(new Headers(f.calls.at(-1)!.init.headers).get("authorization")).toBe(
    "Bearer signed.session",
  );
});

test("native login stores only the signed response header and scopes API requests to its kernel", async () => {
  const f = fixture();
  expect((await f.client.restore()).identity).toBeNull();
  await f.client.signIn("owner@example.test", "test password only");
  expect(
    f.saved.get(credentialStorageKey("https://company.example", "workspace-a")),
  ).toBe("signed.session");
  await request("https://company.example", "/workspace");
  await request("https://other.example", "/workspace");
  await request("https://company.example", "/health");
  const recent = f.calls.slice(-3);
  expect(new Headers(recent[0]!.init.headers).get("authorization")).toBe(
    "Bearer signed.session",
  );
  expect(new Headers(recent[1]!.init.headers).has("authorization")).toBe(false);
  expect(new Headers(recent[2]!.init.headers).has("authorization")).toBe(false);
  expect(recent.every((c) => c.init.credentials === "omit")).toBe(true);
  expect(f.calls.every((c) => c.init.redirect === "error")).toBe(true);
});

test("your account changes its password, lists its devices and signs one out, with its own credential", async () => {
  const f = fixture();
  await f.client.restore();
  await f.client.signIn("owner@example.test", "test password only");
  await f.client.changePassword(
    "test password only",
    "new test password",
    true,
  );
  const { devices, current } = await f.client.devices();
  await f.client.signOutDevice("other-token");
  const sent = (path: string) =>
    f.calls.find((call) => new URL(call.url).pathname === path)!;
  expect(
    JSON.parse(String(sent("/api/auth/change-password").init.body)),
  ).toEqual({
    currentPassword: "test password only",
    newPassword: "new test password",
    revokeOtherSessions: true,
  });
  expect(devices.map((device) => device.id)).toEqual(["session", "other"]);
  expect(current).toBe("session");
  expect(
    JSON.parse(String(sent("/api/auth/revoke-session").init.body)),
  ).toEqual({
    token: "other-token",
  });
  for (const path of [
    "/api/auth/change-password",
    "/api/auth/list-sessions",
    "/api/auth/revoke-session",
  ])
    expect(new Headers(sent(path).init.headers).get("authorization")).toBe(
      "Bearer signed.session",
    );
});

test("a missing native token header is an error, never an apparent successful login", async () => {
  const f = fixture();
  await f.client.restore();
  f.state.nativeHeader = false;
  await expect(
    f.client.signIn("owner@example.test", "test password only"),
  ).rejects.toThrow();
  expect(f.saved.size).toBe(0);
});

test("signup sends only account details and claims the existing owner with a bodyless POST", async () => {
  const f = fixture();
  await f.client.restore();
  const identity = await f.client.signUp(
    " Owner ",
    " owner@example.test ",
    "test password only",
  );
  expect(identity.actor_id).toBe("existing-owner");
  expect(identity.setup_required).toBe(false);
  const signup = f.calls.find((c) => c.url.endsWith("/sign-up/email"))!;
  expect(signup.init.method).toBe("POST");
  expect(JSON.parse(signup.init.body as string)).toEqual({
    name: "Owner",
    email: "owner@example.test",
    password: "test password only",
  });
  expect([...new Headers(signup.init.headers).keys()]).toEqual([
    "content-type",
  ]);
  const claim = f.calls.find((c) => c.url.endsWith("/claim"))!;
  expect(claim.init.method).toBe("POST");
  expect(claim.init.body).toBeUndefined();
  expect(Object.fromEntries(new Headers(claim.init.headers))).toEqual({
    authorization: "Bearer signed.session",
  });
});

test("an interrupted claim can finish after signing in without registering again", async () => {
  const f = fixture();
  await f.client.restore();
  f.state.claimUnavailable = true;
  await expect(
    f.client.signUp("Owner", "owner@example.test", "fixture password"),
  ).rejects.toMatchObject({ status: 503 });
  expect(f.state.bound).toBe(false);
  f.state.claimUnavailable = false;
  const signedIn = await f.client.signIn(
    "owner@example.test",
    "fixture password",
  );
  expect(signedIn.actor_id).toBeNull();
  expect((await f.client.claim()).actor_id).toBe("existing-owner");
  expect(f.calls.filter((c) => c.url.endsWith("/sign-up/email"))).toHaveLength(
    1,
  );
});

test("closed registration stays a failure and never attempts a claim", async () => {
  const f = fixture();
  f.state.setup = false;
  const restored = await f.client.restore();
  expect(restored.health.auth.setup_required).toBe(false);
  await expect(
    f.client.signUp("Other", "other@example.test", "fixture password"),
  ).rejects.toMatchObject({ status: 403 });
  expect(f.calls.some((c) => c.url.endsWith("/claim"))).toBe(false);
  expect(f.saved.size).toBe(0);
});

test("browser signup claims through its cookie session without a request body", async () => {
  const f = fixture(false);
  await f.client.restore();
  expect(
    (await f.client.signUp("Owner", "owner@example.test", "fixture password"))
      .actor_id,
  ).toBe("existing-owner");
  const claim = f.calls.find((c) => c.url.endsWith("/claim"))!;
  expect(claim.init.method).toBe("POST");
  expect(claim.init.body).toBeUndefined();
  expect(claim.init.credentials).toBe("same-origin");
  expect([...new Headers(claim.init.headers).keys()]).toEqual([]);
});

test("browser login uses cookies, without saving a bearer or sending it with domain requests", async () => {
  const f = fixture(false);
  await f.client.restore();
  await f.client.signIn("owner@example.test", "test password only");
  await request("https://company.example", "/workspace");
  expect(f.saved.size).toBe(0);
  expect(f.calls.at(-1)!.init.credentials).toBe("same-origin");
  expect(new Headers(f.calls.at(-1)!.init.headers).has("authorization")).toBe(
    false,
  );
});

test("logout revokes remotely before forgetting a native credential; an outage is not a successful logout", async () => {
  const f = fixture();
  await f.client.restore();
  await f.client.signIn("owner@example.test", "test password only");
  f.state.unavailable = true;
  await expect(f.client.signOut()).rejects.toMatchObject({ status: 503 });
  expect(f.saved.size).toBe(1);
  f.state.unavailable = false;
  await f.client.signOut();
  expect(f.saved.size).toBe(0);
  await request("https://company.example", "/workspace");
  expect(new Headers(f.calls.at(-1)!.init.headers).has("authorization")).toBe(
    false,
  );
  expect(f.calls.at(-1)!.init.credentials).toBe("omit");
});

test("a native client without a stored token does not try a stale cookie session", async () => {
  const f = fixture();
  f.state.signed = true; // a hypothetical stale native cookie jar
  expect((await f.client.restore()).identity).toBeNull();
  expect(f.calls.map((c) => c.url)).toEqual([
    "https://company.example/api/health",
  ]);
});

test("a late unauthorized response cannot erase a newer login", async () => {
  let complete!: (response: Response) => void;
  globalThis.fetch = (() =>
    new Promise<Response>((resolve) => {
      complete = resolve;
    })) as unknown as typeof fetch;
  bindCredential("https://company.example", "workspace-a", "old.session");
  const pending = request("https://company.example", "/workspace").catch(
    (error: unknown) => error,
  );
  bindCredential("https://company.example", "workspace-a", "new.session");
  complete(Response.json({ error: "Expired" }, { status: 401 }));
  await pending;
  const sent: (string | null)[] = [];
  globalThis.fetch = (async (_url: string, init: RequestInit) => {
    sent.push(new Headers(init.headers).get("authorization"));
    return Response.json({});
  }) as unknown as typeof fetch;
  await request("https://company.example", "/workspace");
  expect(sent).toEqual(["Bearer new.session"]);
});

test("native authentication works on an explicitly selected LAN HTTP connection", async () => {
  const kernel = "http://192.168.1.10:4310";
  const f = fixture(true, "workspace-a", kernel);
  expect((await f.client.restore()).identity).toBeNull();
  expect(
    (
      await f.client.signUp(
        "Owner",
        "owner@example.test",
        "fixture-only-password",
      )
    ).actor_id,
  ).toBe("existing-owner");
  expect(f.saved.get(credentialStorageKey(kernel, "workspace-a"))).toBe(
    "signed.session",
  );
  await request(kernel, "/workspace");
  expect(new Headers(f.calls.at(-1)!.init.headers).get("authorization")).toBe(
    "Bearer signed.session",
  );
  expect(
    f.calls.every(
      ({ init }) =>
        init.credentials === "omit" &&
        init.redirect === "error" &&
        init.cache === "no-store",
    ),
  ).toBe(true);
  await f.client.signOut();
  expect(f.saved.size).toBe(0);
});

test("LAN HTTP is supported but public HTTP and private-looking hostnames are not", () => {
  for (const origin of [
    "http://192.168.1.10:4310",
    "http://10.0.0.2:4310",
    "http://172.16.0.2:4310",
    "http://172.31.255.254:4310",
    "http://169.254.1.2:4310",
    "http://[fd00::1]:4310",
    "http://[fe80::1]:4310",
  ])
    expect(secureKernelOrigin(origin)).toBe(origin);
  for (const origin of [
    "http://company.example",
    "http://172.15.0.2:4310",
    "http://172.32.0.2:4310",
    "http://[2001:db8::1]:4310",
    "http://192.168.1.10.attacker.example",
  ])
    expect(() => secureKernelOrigin(origin)).toThrow();
});

test("secure-store keys cannot collide across address or workspace, and public auth requires HTTPS", () => {
  const keys = [
    credentialStorageKey("https://a.example", "workspace-a"),
    credentialStorageKey("https://a.example", "workspace-b"),
    credentialStorageKey("https://b.example", "workspace-a"),
  ];
  expect(new Set(keys).size).toBe(3);
  expect(keys.every((key) => /^[a-zA-Z0-9._-]+$/.test(key))).toBe(true);
  expect(secureKernelOrigin("http://127.0.0.1:4310")).toBe(
    "http://127.0.0.1:4310",
  );
  expect(() => secureKernelOrigin("http://192.0.2.10:4310")).toThrow();
  expect(() =>
    secureKernelOrigin("https://user:secret@company.example"),
  ).toThrow();
});

test("a kernel without sign-in is used as it is, whatever its version, without credentials", async () => {
  const { client, state, calls, reads } = fixture(true);
  state.legacy = true;
  const result = await client.restore();
  expect(result.identity).toBeNull();
  expect(result.health.capabilities).toEqual(["chat-v1"]);
  expect(result.health.auth.setup_required).toBe(false);
  // Nothing was read from storage and no sign-in request was made.
  expect(reads).toEqual([]);
  expect(calls.map((c) => new URL(c.url).pathname)).toEqual(["/api/health"]);
});
