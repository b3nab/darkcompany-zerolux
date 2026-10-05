import { afterEach, expect, test } from "bun:test";
import { ApiError, api, request, setKernelUrl } from "./client";

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

test("a refusal carries its status, so a client can tell it from an unreachable kernel", async () => {
  globalThis.fetch = (async () =>
    Response.json(
      { error: "Conversation is paused" },
      { status: 409 },
    )) as unknown as typeof fetch;
  const error = await api("/x", {}).catch((e: unknown) => e);
  expect(error).toBeInstanceOf(ApiError);
  expect((error as ApiError).status).toBe(409);
  expect((error as ApiError).message).toBe("Conversation is paused");
});

test("a call to a given kernel ignores the current one", async () => {
  const urls: string[] = [];
  globalThis.fetch = (async (url: string) => {
    urls.push(url);
    return Response.json({});
  }) as unknown as typeof fetch;
  setKernelUrl("http://b:4310");
  await request("http://a:4310/", "/chat/sessions");
  expect(urls).toEqual(["http://a:4310/api/chat/sessions"]);
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
