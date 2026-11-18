import { afterEach, expect, test } from "bun:test";
import { ApiError, Unreachable, api, request, setKernelUrl } from "./client";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
  setKernelUrl("");
});

test("the web app calls its own origin; an app calls the kernel address it was given", async () => {
  const urls: string[] = [];
  globalThis.fetch = (async (url: string) => {
    urls.push(url);
    return Response.json({ ok: true });
  }) as unknown as typeof fetch;
  await api("/health");
  setKernelUrl("http://192.0.2.10:4310/");
  await api("/health");
  expect(urls).toEqual(["/api/health", "http://192.0.2.10:4310/api/health"]);
});

test("an unsuccessful response carries its HTTP status and machine-readable reason", async () => {
  globalThis.fetch = (async () =>
    Response.json(
      { error: "Fixture unconfirmed", code: "session_settings_unconfirmed" },
      { status: 504 },
    )) as unknown as typeof fetch;
  const error = await api("/x", {}).catch((e: unknown) => e);
  expect(error).toBeInstanceOf(ApiError);
  expect((error as ApiError).status).toBe(504);
  expect((error as ApiError).code).toBe("session_settings_unconfirmed");
  expect((error as ApiError).message).toBe("Fixture unconfirmed");
});

test("a call with no answer fails the same way everywhere; one its caller gave up stays its own", async () => {
  // Each browser and app words a failed fetch its own way.
  for (const said of [
    "Load failed",
    "Failed to fetch",
    "Network request failed",
  ]) {
    globalThis.fetch = (async () => {
      throw new TypeError(said);
    }) as unknown as typeof fetch;
    const error = await api("/x").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Unreachable);
    expect((error as Error).message).not.toBe(said);
  }
  const gaveUp = new AbortController();
  gaveUp.abort();
  const aborted = new DOMException("Aborted", "AbortError");
  globalThis.fetch = (async () => {
    throw aborted;
  }) as unknown as typeof fetch;
  expect(
    await api("/x", undefined, gaveUp.signal).catch((e: unknown) => e),
  ).toBe(aborted);
});

test("a call to a given kernel ignores the current one", async () => {
  const urls: string[] = [];
  globalThis.fetch = (async (url: string) => {
    urls.push(url);
    return Response.json({});
  }) as unknown as typeof fetch;
  setKernelUrl("http://b:4310");
  await request("http://a:4310/", "/sessions");
  expect(urls).toEqual(["http://a:4310/api/sessions"]);
});

test("a file is sent as it is, with its own type", async () => {
  const sent: RequestInit[] = [];
  globalThis.fetch = (async (_: string, init: RequestInit) => {
    sent.push(init);
    return Response.json({});
  }) as unknown as typeof fetch;
  const file = new File(["# Notes"], "notes.md", { type: "text/markdown" });
  await api("/storage/files?name=notes.md", file);
  await api("/x", { a: 1 });
  expect(sent[0]!.body).toBe(file);
  expect(sent[0]!.headers).toEqual({ "Content-Type": "text/markdown" });
  expect(sent[1]!.body).toBe('{"a":1}');
  expect(sent[1]!.headers).toEqual({ "Content-Type": "application/json" });
});
