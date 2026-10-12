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
      return Response.json({
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
      state.bound = true;
      state.setup = false;
      return Response.json(identity());
    }
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
  await expect(f.client.restore()).rejects.toThrow("different workspace");
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
    await expect(f.client.restore()).rejects.toThrow("identity changed");
  const count = f.calls.length;
  await expect(
    f.client.signIn("owner@example.test", "do not send this"),
  ).rejects.toThrow("Verify the workspace");
  await expect(
    f.client.signUp("Owner", "owner@example.test", "do not send this", "proof"),
  ).rejects.toThrow("Verify the workspace");
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

test("a missing native token header is an error, never an apparent successful login", async () => {
  const f = fixture();
  await f.client.restore();
  f.state.nativeHeader = false;
  await expect(
    f.client.signIn("owner@example.test", "test password only"),
  ).rejects.toThrow("native session credential");
  expect(f.saved.size).toBe(0);
});

test("signup passes the setup proof only to its kernel and claims the existing owner after login", async () => {
  const f = fixture();
  await f.client.restore();
  const identity = await f.client.signUp(
    "Owner",
    "owner@example.test",
    "test password only",
    "one-time-setup",
  );
  expect(identity.actor_id).toBe("existing-owner");
  const signup = f.calls.find((c) => c.url.endsWith("/sign-up/email"))!;
  expect(new Headers(signup.init.headers).get("x-zerolux-setup-token")).toBe(
    "one-time-setup",
  );
  const claim = f.calls.find((c) => c.url.endsWith("/claim"))!;
  expect(JSON.parse(claim.init.body as string)).toEqual({
    setup_token: "one-time-setup",
  });
  expect(new Headers(claim.init.headers).get("authorization")).toBe(
    "Bearer signed.session",
  );
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
  await expect(f.client.signOut()).rejects.toThrow("Unavailable");
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
        "setup-proof",
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
    expect(() => secureKernelOrigin(origin)).toThrow("HTTPS");
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
  expect(() => secureKernelOrigin("http://192.0.2.10:4310")).toThrow("HTTPS");
  expect(() =>
    secureKernelOrigin("https://user:secret@company.example"),
  ).toThrow();
});
