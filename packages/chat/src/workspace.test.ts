import { afterEach, expect, test } from "bun:test";
import { ApiError, setKernelUrl } from "./client";
import { creationDateLabel, workspaceAge } from "./dates";
import { renameWorkspace } from "./workspace";
import type { WorkspaceInfo } from "./workspace";

const DAY = 86_400_000;
const info: WorkspaceInfo = {
  id: "workspace",
  name: "Workspace",
  created_at: Date.UTC(2026, 0, 2, 12),
};
const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
  setKernelUrl("");
});

test("creation labels format the stored timestamp as a UTC date", () => {
  expect(creationDateLabel(info)).toBe("Created 2026-01-02");
  expect(creationDateLabel({ created_at: 0 })).toBe("Created 1970-01-01");
});

test("company days start at one, include epoch zero and never become negative", () => {
  expect(workspaceAge(info, info.created_at)).toBe("Day 1");
  expect(workspaceAge(info, info.created_at + DAY - 1)).toBe("Day 1");
  expect(workspaceAge(info, info.created_at + DAY)).toBe("Day 2");
  expect(workspaceAge({ ...info, created_at: 0 }, 0)).toBe("Day 1");
  expect(workspaceAge(info, info.created_at - DAY)).toBe("Created 2026-01-02");
});

test("invalid timestamps cannot crash the profile or invent a company age", () => {
  for (const created_at of [NaN, Infinity, -1, 8.64e15 + 1]) {
    const record = { ...info, created_at };
    expect(creationDateLabel(record)).toBe("Creation date unavailable");
    expect(workspaceAge(record)).toBe("Creation date unavailable");
  }
});

test("renaming posts only the trimmed name and returns the authoritative metadata", async () => {
  let sent: { url: string; init: RequestInit } | undefined;
  const renamed = { ...info, name: "Research studio" };
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    sent = { url, init };
    return Response.json({ workspace: renamed });
  }) as unknown as typeof fetch;
  expect(await renameWorkspace("  Research studio  ")).toEqual(renamed);
  expect(sent?.url).toBe("/api/workspace");
  expect(sent?.init.method).toBe("POST");
  expect(JSON.parse(sent!.init.body as string)).toEqual({
    name: "Research studio",
  });
});

test("a mounted client's rename stays bound to its kernel after another one is selected", async () => {
  const urls: string[] = [];
  globalThis.fetch = (async (url: string) => {
    urls.push(url);
    return Response.json({ workspace: info });
  }) as unknown as typeof fetch;
  setKernelUrl("http://192.0.2.20:4310");
  await renameWorkspace("Workspace", "http://192.0.2.10:4310");
  expect(urls).toEqual(["http://192.0.2.10:4310/api/workspace"]);
});

test("a refused rename is not reported as saved", async () => {
  globalThis.fetch = (async () =>
    Response.json(
      { error: "Forbidden" },
      { status: 403 },
    )) as unknown as typeof fetch;
  const failure = await renameWorkspace("Other").catch(
    (error: unknown) => error,
  );
  expect(failure).toBeInstanceOf(ApiError);
  expect((failure as ApiError).status).toBe(403);
  expect((failure as ApiError).message).toBe("Forbidden");
});
