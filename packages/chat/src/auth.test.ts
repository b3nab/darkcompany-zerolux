import { afterEach, expect, test } from "bun:test";
import {
  AuthConnection,
  credentialStorageKey,
  kernelId,
  probeKernel,
  type AuthStorage,
} from "./auth";
import { request, setKernelFetch } from "./client";
import { bindCredential, clearCredential } from "./credentials";
import { secureKernelAddress } from "./instance";

const originalFetch = globalThis.fetch;
const clients: AuthConnection[] = [];
afterEach(() => {
  for (const client of clients.splice(0)) client.dispose();
  for (const origin of [
    "https://company.example",
    "https://other.example",
    "http://192.168.1.10:4310",
  ])
    clearCredential(origin);
  globalThis.fetch = originalFetch;
  setKernelFetch();
});

const KERNEL = "https://company.example";

/**
 * A fake kernel: `instance` signs in once for all its workspaces at /w/<id>; `older` serves one
 * workspace at its origin with its own sign-in; `unsigned` has no sign-in at all.
 */
function fixture({
  native = true,
  expected = "instance-a",
  kernel = KERNEL,
  kind = "instance" as "instance" | "older" | "unsigned",
} = {}) {
  const saved = new Map<string, string>();
  const reads: string[] = [];
  const calls: { url: string; init: RequestInit }[] = [];
  const state = {
    kind,
    id: "instance-a",
    accounts: false,
    signed: false,
    members: new Set<string>(),
    workspaces: [] as { id: string; name: string; owner: boolean }[],
    unavailable: false,
    nativeHeader: true,
    identityUnauthorized: false,
    claimUnavailable: false,
  };
  const storage: AuthStorage = {
    async read(kernel) {
      const key = credentialStorageKey(kernel);
      reads.push(key);
      return saved.get(key) ?? null;
    },
    async write(kernel, token) {
      const key = credentialStorageKey(kernel);
      if (token) saved.set(key, token);
      else saved.delete(key);
    },
  };
  const user = {
    id: "auth-subject",
    name: "Owner",
    email: "owner@example.test",
  };
  // An older kernel's one workspace is the kernel itself: bound once its owner claims it.
  const person = (id: string) => {
    const owned = state.workspaces.find((w) => w.id === id)?.owner ?? false;
    return {
      user,
      actor_id: state.members.has(id) ? `person-${id}` : null,
      owner: state.members.has(id) && (state.kind === "older" || owned),
      setup_required: state.kind === "older" && !state.members.has(id),
    };
  };
  globalThis.fetch = (async (url: string, init: RequestInit = {}) => {
    calls.push({ url, init });
    const full = new URL(url).pathname;
    const scoped = /^\/w\/([^/]+)(\/api\/.*)$/.exec(full);
    const workspace = scoped ? decodeURIComponent(scoped[1]!) : undefined;
    const path = scoped ? scoped[2]! : full;
    const json = init.body ? (JSON.parse(String(init.body)) as unknown) : {};
    if (state.unavailable)
      return Response.json({ error: "Unavailable" }, { status: 503 });
    if (path === "/api/health")
      return Response.json(
        state.kind === "instance"
          ? {
              api_version: 3,
              capabilities: ["workspaces-v1", "instance-auth-v1"],
              instance: { id: state.id },
              auth: { setup_required: !state.accounts },
            }
          : state.kind === "older"
            ? {
                api_version: 2,
                capabilities: ["auth-v1", "chat-v1"],
                workspace: { id: state.id, name: "Company" },
                auth: { setup_required: !state.members.has(state.id) },
              }
            : {
                api_version: 1,
                capabilities: ["chat-v1"],
                workspace: { id: state.id, name: "Company" },
              },
      );
    if (path === "/api/auth/get-session")
      return Response.json(
        state.signed ? { session: { id: "session" } } : null,
      );
    if (path === "/api/auth/identity") {
      if (state.identityUnauthorized || !state.signed)
        return Response.json({ error: "Unauthorized" }, { status: 401 });
      if (workspace) return Response.json(person(workspace));
      return Response.json(
        state.kind === "older"
          ? person(state.id)
          : { user, setup_required: !state.accounts },
      );
    }
    const invited =
      new Headers(init.headers).get("x-zerolux-invite") === "invite-1";
    if (path === "/api/auth/sign-up/email") {
      const open =
        state.kind === "older" ? !state.members.has(state.id) : !state.accounts;
      if (!open && !invited)
        return Response.json({ error: "Sign in instead" }, { status: 403 });
    }
    if (["/api/auth/sign-in/email", "/api/auth/sign-up/email"].includes(path)) {
      state.signed = true;
      state.accounts = true;
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
      const id = workspace ?? state.id;
      const invite = (json as { invite?: string }).invite;
      if (state.members.has(id) || (!invite && state.kind === "instance"))
        return Response.json({ error: "Not this way" }, { status: 409 });
      if (invite && invite !== "invite-1")
        return Response.json({ error: "Gone" }, { status: 410 });
      state.members.add(id);
      return Response.json(person(id));
    }
    if (path.startsWith("/api/auth/invites/"))
      return Response.json({
        invitation: { workspace: "Birch", invited_by: "Owner", expires_at: 1 },
      });
    if (path === "/api/workspaces" && !workspace) {
      if (!state.signed)
        return Response.json({ error: "Unauthorized" }, { status: 401 });
      if (init.method === "POST") {
        const created = {
          id: `ws-${state.workspaces.length + 1}`,
          name: (json as { name: string }).name,
          owner: true,
        };
        state.workspaces.push(created);
        state.members.add(created.id);
        return Response.json({ workspace: { ...created, created_at: 1 } });
      }
      return Response.json({
        workspaces: state.workspaces
          .filter((w) => state.members.has(w.id))
          .map((w) => ({ ...w, created_at: 1 })),
      });
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
  const sent = (path: string) =>
    calls.filter((call) => new URL(call.url).pathname === path);
  const bearer = (call: { init: RequestInit } | undefined) =>
    call ? new Headers(call.init.headers).get("authorization") : undefined;
  return { client, state, calls, saved, reads, storage, sent, bearer };
}

test("a native connection verifies the kernel's identity before loading or sending any credential", async () => {
  const f = fixture();
  f.saved.set(credentialStorageKey(KERNEL), "saved.session");
  f.state.signed = true;
  await f.client.restore();
  expect(f.calls[0]!.url).toBe(`${KERNEL}/api/health`);
  expect(f.calls[0]!.init.credentials).toBe("omit");
  expect(f.calls[0]!.init.headers).toBeUndefined();
  expect(f.reads).toHaveLength(1);
  expect(f.bearer(f.calls[1])).toBe("Bearer saved.session");
});

test("a reused address serving another kernel never receives the saved credential", async () => {
  const f = fixture();
  f.saved.set(credentialStorageKey(KERNEL), "saved.session");
  f.state.id = "instance-b";
  await expect(f.client.restore()).rejects.toThrow();
  expect(f.reads).toHaveLength(0);
  expect(f.calls).toHaveLength(1);
  expect(f.calls[0]!.init.credentials).toBe("omit");
});

test("a changed kernel identity disconnects an active credential and cannot accept a subsequent password", async () => {
  const f = fixture({ expected: "" }); // Without an expected ID, the first identity is pinned.
  await f.client.restore();
  await f.client.signIn("owner@example.test", "fixture password");
  f.state.id = "instance-b";
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
  await request(`${KERNEL}/w/ws-1`, "/workspace");
  expect(f.bearer(f.calls.at(-1))).toBeNull();
  expect(f.calls.at(-1)!.init.credentials).toBe("omit");
});

test("the first kernels with several workspaces, which signed in to each apart, are refused before any credential", async () => {
  const f = fixture();
  f.saved.set(credentialStorageKey(KERNEL), "saved.session");
  globalThis.fetch = (async (url: string, init: RequestInit = {}) => {
    f.calls.push({ url, init });
    return Response.json({
      api_version: 2,
      capabilities: ["workspaces-v1", "auth-v1"],
      workspaces: [{ id: "ws-1", name: "Aspen", created_at: 1 }],
    });
  }) as unknown as typeof fetch;
  await expect(f.client.restore()).rejects.toThrow();
  expect(f.reads).toHaveLength(0);
  expect(f.calls).toHaveLength(1);
});

test("an answer that is not a kernel's is refused", async () => {
  for (const health of [
    null,
    { capabilities: [] },
    { capabilities: ["instance-auth-v1"], auth: { setup_required: false } },
    { capabilities: ["instance-auth-v1"], instance: { id: "instance-a" } },
  ]) {
    globalThis.fetch = (async () =>
      Response.json(health)) as unknown as typeof fetch;
    await expect(probeKernel(KERNEL)).rejects.toThrow();
  }
});

test("the first account signs up at the kernel's root and creates a workspace it owns, at its base", async () => {
  const f = fixture();
  const { health } = await f.client.restore();
  expect(health.auth.setup_required).toBe(true);
  expect(kernelId(health)).toBe("instance-a");
  const account = await f.client.signUp(
    " Owner ",
    " owner@example.test ",
    "test password only",
  );
  expect(account.user.email).toBe("owner@example.test");
  expect(await f.client.workspaces()).toEqual([]);
  const created = await f.client.createWorkspace(" Aspen ");
  expect(created).toEqual({
    id: "ws-1",
    name: "Aspen",
    base: `${KERNEL}/w/ws-1`,
    owner: true,
  });
  expect(await f.client.workspaces()).toEqual([created]);
  expect((await f.client.identity(created.base)).actor_id).toBe("person-ws-1");
  const signup = f.sent("/api/auth/sign-up/email")[0]!;
  expect(JSON.parse(String(signup.init.body))).toEqual({
    name: "Owner",
    email: "owner@example.test",
    password: "test password only",
  });
  expect([...new Headers(signup.init.headers).keys()]).toEqual([
    "content-type",
  ]);
  const create = f
    .sent("/api/workspaces")
    .find((c) => c.init.method === "POST")!;
  expect(JSON.parse(String(create.init.body))).toEqual({ name: "Aspen" });
  expect(f.bearer(create)).toBe("Bearer signed.session");
});

test("a workspace is created in a folder of the kernel's computer when one is given", async () => {
  const f = fixture();
  await f.client.restore();
  await f.client.signUp("Owner", "owner@example.test", "fixture password");
  await f.client.createWorkspace("Birch", "/projects/birch");
  const create = f
    .sent("/api/workspaces")
    .find((c) => c.init.method === "POST")!;
  expect(JSON.parse(String(create.init.body))).toEqual({
    name: "Birch",
    folder: "/projects/birch",
  });
});

test("one sign-in serves every workspace of its kernel, and no other kernel", async () => {
  const f = fixture();
  await f.client.restore();
  await f.client.signIn("owner@example.test", "test password only");
  expect(f.saved.get(credentialStorageKey(KERNEL))).toBe("signed.session");
  await request(`${KERNEL}/w/ws-1`, "/workspace");
  await request(`${KERNEL}/w/ws-2`, "/workspace");
  await request("https://other.example/w/ws-1", "/workspace");
  await request(KERNEL, "/health");
  const recent = f.calls.slice(-4);
  expect(recent.map(f.bearer)).toEqual([
    "Bearer signed.session",
    "Bearer signed.session",
    null,
    null,
  ]);
  expect(recent.every((c) => c.init.credentials === "omit")).toBe(true);
  expect(f.calls.every((c) => c.init.redirect === "error")).toBe(true);
});

test("a refused credential in any workspace signs the device out of the whole kernel", async () => {
  const f = fixture();
  await f.client.restore();
  await f.client.signIn("owner@example.test", "test password only");
  let required = 0;
  f.client.onRequired(() => required++);
  globalThis.fetch = (async (url: string, init: RequestInit = {}) => {
    f.calls.push({ url, init });
    return Response.json({ error: "Expired" }, { status: 401 });
  }) as unknown as typeof fetch;
  await expect(request(`${KERNEL}/w/ws-2`, "/workspace")).rejects.toThrow();
  expect(required).toBe(1);
  await expect(request(`${KERNEL}/w/ws-1`, "/workspace")).rejects.toThrow();
  expect(f.bearer(f.calls.at(-1))).toBeNull();
});

test("a new person signs up with an invitation at the root and joins its workspace with a claim there", async () => {
  const f = fixture();
  f.state.accounts = true;
  f.state.workspaces.push({ id: "ws-2", name: "Birch", owner: false });
  await f.client.restore();
  const base = `${KERNEL}/w/ws-2`;
  expect((await f.client.invitation(base, "invite-1")).workspace).toBe("Birch");
  await expect(
    f.client.signUp("Maple", "maple@example.test", "fixture password"),
  ).rejects.toMatchObject({ status: 403 });
  await f.client.signUp(
    "Maple",
    "maple@example.test",
    "fixture password",
    "invite-1",
  );
  const joined = await f.client.claim(base, "invite-1");
  expect(joined.actor_id).toBe("person-ws-2");
  expect(joined.owner).toBe(false);
  expect((await f.client.workspaces()).map((w) => w.id)).toEqual(["ws-2"]);
  const signup = f.sent("/api/auth/sign-up/email").at(-1)!;
  expect(new Headers(signup.init.headers).get("x-zerolux-invite")).toBe(
    "invite-1",
  );
  const claim = f.sent("/w/ws-2/api/auth/claim")[0]!;
  expect(JSON.parse(String(claim.init.body))).toEqual({ invite: "invite-1" });
  expect(f.bearer(claim)).toBe("Bearer signed.session");
  expect(f.sent("/w/ws-2/api/auth/invites/invite-1")).toHaveLength(1);
});

test("an account already signed in joins another workspace with only a claim", async () => {
  const f = fixture();
  f.state.accounts = true;
  f.state.workspaces.push(
    { id: "ws-1", name: "Aspen", owner: true },
    { id: "ws-2", name: "Birch", owner: false },
  );
  f.state.members.add("ws-1");
  await f.client.restore();
  await f.client.signIn("owner@example.test", "fixture password");
  await f.client.claim(`${KERNEL}/w/ws-2`, "invite-1");
  expect(f.sent("/api/auth/sign-up/email")).toHaveLength(0);
  expect(await f.client.workspaces()).toEqual([
    { id: "ws-1", name: "Aspen", base: `${KERNEL}/w/ws-1`, owner: true },
    { id: "ws-2", name: "Birch", base: `${KERNEL}/w/ws-2`, owner: false },
  ]);
});

test("a workspace on another kernel never gets this kernel's sign-in", async () => {
  const f = fixture();
  await f.client.restore();
  await f.client.signIn("owner@example.test", "fixture password");
  const count = f.calls.length;
  const elsewhere = "https://other.example/w/ws-1";
  await expect(f.client.identity(elsewhere)).rejects.toThrow();
  await expect(f.client.claim(elsewhere, "invite-1")).rejects.toThrow();
  await expect(f.client.invitation(elsewhere, "invite-1")).rejects.toThrow();
  expect(f.calls).toHaveLength(count);
});

test("revocation between get-session and identity forgets the expired native credential", async () => {
  const f = fixture();
  await f.client.restore();
  await f.client.signIn("owner@example.test", "fixture password");
  f.state.identityUnauthorized = true;
  expect((await f.client.restore()).identity).toBeNull();
  expect(f.saved.size).toBe(0);
  await request(`${KERNEL}/w/ws-1`, "/workspace");
  expect(f.bearer(f.calls.at(-1))).toBeNull();
});

test("the selected native transport carries auth and domain requests with no redirects or cookies", async () => {
  const f = fixture();
  const nativeFetch = globalThis.fetch;
  setKernelFetch((url, init) => nativeFetch(url, init));
  globalThis.fetch = (() => {
    throw new Error("The RN/XHR compatibility transport must not be used");
  }) as unknown as typeof fetch;
  await probeKernel(`${KERNEL}/w/ws-1`);
  await f.client.restore();
  await f.client.signIn("owner@example.test", "fixture password");
  await request(`${KERNEL}/w/ws-1`, "/workspace");
  expect(
    f.calls.every(
      (c) => c.init.redirect === "error" && c.init.credentials === "omit",
    ),
  ).toBe(true);
  expect(f.calls[0]!.url).toBe(`${KERNEL}/api/health`);
  expect(f.bearer(f.calls.at(-1))).toBe("Bearer signed.session");
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
  const sent = (path: string) => f.sent(path)[0]!;
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
  ).toEqual({ token: "other-token" });
  for (const path of [
    "/api/auth/change-password",
    "/api/auth/list-sessions",
    "/api/auth/revoke-session",
  ])
    expect(f.bearer(sent(path))).toBe("Bearer signed.session");
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

test("browser sign-in and claim use the cookie session, without saving or sending a bearer", async () => {
  const f = fixture({ native: false });
  f.state.accounts = true;
  f.state.workspaces.push({ id: "ws-2", name: "Birch", owner: false });
  await f.client.restore();
  await f.client.signIn("owner@example.test", "test password only");
  await f.client.claim(`${KERNEL}/w/ws-2`, "invite-1");
  await request(`${KERNEL}/w/ws-2`, "/workspace");
  expect(f.saved.size).toBe(0);
  const claim = f.sent("/w/ws-2/api/auth/claim")[0]!;
  expect(claim.init.credentials).toBe("same-origin");
  expect(f.bearer(claim)).toBeNull();
  expect(f.calls.at(-1)!.init.credentials).toBe("same-origin");
  expect(f.bearer(f.calls.at(-1))).toBeNull();
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
  await request(`${KERNEL}/w/ws-1`, "/workspace");
  expect(f.bearer(f.calls.at(-1))).toBeNull();
  expect(f.calls.at(-1)!.init.credentials).toBe("omit");
});

test("a native client without a stored token does not try a stale cookie session", async () => {
  const f = fixture();
  f.state.signed = true; // a hypothetical stale native cookie jar
  expect((await f.client.restore()).identity).toBeNull();
  expect(f.calls.map((c) => c.url)).toEqual([`${KERNEL}/api/health`]);
});

test("a late unauthorized response cannot erase a newer login", async () => {
  let complete!: (response: Response) => void;
  globalThis.fetch = (() =>
    new Promise<Response>((resolve) => {
      complete = resolve;
    })) as unknown as typeof fetch;
  bindCredential(KERNEL, "old.session");
  const pending = request(`${KERNEL}/w/ws-1`, "/workspace").catch(
    (error: unknown) => error,
  );
  bindCredential(KERNEL, "new.session");
  complete(Response.json({ error: "Expired" }, { status: 401 }));
  await pending;
  const sent: (string | null)[] = [];
  globalThis.fetch = (async (_url: string, init: RequestInit) => {
    sent.push(new Headers(init.headers).get("authorization"));
    return Response.json({});
  }) as unknown as typeof fetch;
  await request(`${KERNEL}/w/ws-2`, "/workspace");
  expect(sent).toEqual(["Bearer new.session"]);
});

test("native authentication works on an explicitly selected LAN HTTP connection", async () => {
  const kernel = "http://192.168.1.10:4310";
  const f = fixture({ kernel });
  expect((await f.client.restore()).identity).toBeNull();
  await f.client.signUp("Owner", "owner@example.test", "fixture-only-password");
  const created = await f.client.createWorkspace("Aspen");
  expect(created.base).toBe(`${kernel}/w/ws-1`);
  expect(f.saved.get(credentialStorageKey(kernel))).toBe("signed.session");
  await request(created.base, "/workspace");
  expect(f.bearer(f.calls.at(-1))).toBe("Bearer signed.session");
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

test("an older kernel serves one workspace at its origin, set up by the claim of its owner", async () => {
  const f = fixture({ kind: "older" });
  const { health } = await f.client.restore();
  expect(kernelId(health)).toBe("instance-a");
  expect(health.auth.setup_required).toBe(true);
  await f.client.signUp("Owner", "owner@example.test", "fixture password");
  const owner = await f.client.claim(KERNEL);
  expect(owner.actor_id).toBe("person-instance-a");
  expect(owner.setup_required).toBe(false);
  expect(health.auth.setup_required).toBe(false);
  expect(await f.client.workspaces()).toEqual([
    { id: "instance-a", name: "Company", base: KERNEL, owner: true },
  ]);
  await expect(f.client.createWorkspace("Birch")).rejects.toThrow();
  const claim = f.sent("/api/auth/claim")[0]!;
  expect(claim.init.method).toBe("POST");
  expect(claim.init.body).toBeUndefined();
  expect(f.saved.get(credentialStorageKey(KERNEL))).toBe("signed.session");
});

test("closed registration stays a failure and nothing is saved", async () => {
  const f = fixture();
  f.state.accounts = true;
  const restored = await f.client.restore();
  expect(restored.health.auth.setup_required).toBe(false);
  await expect(
    f.client.signUp("Other", "other@example.test", "fixture password"),
  ).rejects.toMatchObject({ status: 403 });
  expect(f.sent("/api/auth/identity")).toHaveLength(0);
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
    expect(secureKernelAddress(origin)).toBe(origin);
  for (const origin of [
    "http://company.example",
    "http://172.15.0.2:4310",
    "http://172.32.0.2:4310",
    "http://[2001:db8::1]:4310",
    "http://192.168.1.10.attacker.example",
  ])
    expect(() => secureKernelAddress(origin)).toThrow();
});

test("a workspace on a kernel is addressed by its base, and no other path is", () => {
  expect(secureKernelAddress("http://192.168.1.10:4310/w/workspace-a")).toBe(
    "http://192.168.1.10:4310/w/workspace-a",
  );
  expect(secureKernelAddress("https://company.example/w/workspace-a/")).toBe(
    "https://company.example/w/workspace-a",
  );
  for (const address of [
    "https://company.example/api",
    "https://company.example/w/",
    "https://company.example/w/a/b",
    "https://company.example/w/a?x=1",
    "http://192.0.2.10:4310/w/workspace-a",
  ])
    expect(() => secureKernelAddress(address)).toThrow();
});

test("a kernel's secure-store key is the same from any of its workspaces, and the keys before it stay apart", () => {
  expect(credentialStorageKey("http://192.168.1.10:4310/w/workspace-a")).toBe(
    credentialStorageKey("http://192.168.1.10:4310"),
  );
  const keys = [
    credentialStorageKey("https://a.example"),
    credentialStorageKey("https://b.example"),
    credentialStorageKey("https://a.example", "workspace-a"),
    credentialStorageKey("https://a.example", "workspace-b"),
    credentialStorageKey("https://b.example", "workspace-a"),
  ];
  expect(new Set(keys).size).toBe(5);
  expect(keys.every((key) => /^[a-zA-Z0-9._-]+$/.test(key))).toBe(true);
  expect(secureKernelAddress("http://127.0.0.1:4310")).toBe(
    "http://127.0.0.1:4310",
  );
  expect(() => secureKernelAddress("http://192.0.2.10:4310")).toThrow();
  expect(() =>
    secureKernelAddress("https://user:secret@company.example"),
  ).toThrow();
});

test("a kernel without sign-in is used as it is, whatever its version, without credentials", async () => {
  const f = fixture({ kind: "unsigned" });
  const result = await f.client.restore();
  expect(result.identity).toBeNull();
  expect(result.health.capabilities).toEqual(["chat-v1"]);
  expect(result.health.auth.setup_required).toBe(false);
  expect(await f.client.workspaces()).toEqual([
    { id: "instance-a", name: "Company", base: KERNEL, owner: true },
  ]);
  // Nothing was read from storage and no sign-in request was made.
  expect(f.reads).toEqual([]);
  expect(f.calls.map((c) => new URL(c.url).pathname)).toEqual(["/api/health"]);
});
