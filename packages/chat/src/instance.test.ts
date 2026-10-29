import { afterEach, expect, test } from "bun:test";
import { readInstance } from "./auth";
import { request, setKernelFetch } from "./client";
import { pieceUrl } from "./extension-ui";
import type { UiPiece } from "./extension-ui";
import {
  pickWorkspace,
  rememberedWorkspace,
  rememberWorkspace,
  workspaceAddress,
  workspaceBase,
} from "./instance";
import { inviteLink, readInviteLink } from "./people";

const kernel = "http://192.168.1.10:4310";

afterEach(() => {
  setKernelFetch();
  delete (globalThis as { localStorage?: unknown }).localStorage;
});

/** A kernel that answers its root health with `health`, noting what was asked and how. */
function answering(health: unknown) {
  const asked: { url: string; init?: RequestInit }[] = [];
  setKernelFetch(async (url, init) => {
    asked.push({ url, init });
    return Response.json(health);
  });
  return asked;
}

test("a kernel with workspaces-v1 lists its workspaces, each at its base, read with no credentials", async () => {
  const asked = answering({
    name: "zerolux",
    version: "0.0.2",
    api_version: 2,
    capabilities: ["workspaces-v1"],
    workspaces: [
      { id: "ws-a", name: "Aspen", created_at: 1 },
      { id: "ws-b", name: "Birch", created_at: 2 },
    ],
  });
  const instance = await readInstance(`${kernel}/w/ws-b`);
  expect(instance).toEqual({
    kernel,
    multi: true,
    version: "0.0.2",
    workspaces: [
      { id: "ws-a", name: "Aspen", base: `${kernel}/w/ws-a` },
      { id: "ws-b", name: "Birch", base: `${kernel}/w/ws-b` },
    ],
  });
  expect(asked.map((a) => a.url)).toEqual([`${kernel}/api/health`]);
  expect(asked[0]!.init?.credentials).toBe("omit");
  expect(asked[0]!.init?.redirect).toBe("error");
});

test("a kernel without workspaces-v1 is one workspace, at its origin", async () => {
  answering({
    api_version: 1,
    capabilities: ["auth-v1"],
    workspace: { id: "ws-a", name: "Aspen" },
    auth: { setup_required: false },
  });
  const instance = await readInstance(kernel);
  expect(instance.multi).toBe(false);
  expect(instance.workspaces).toEqual([
    { id: "ws-a", name: "Aspen", base: kernel },
  ]);
});

test("an answer that is not a kernel's is refused", async () => {
  for (const health of [
    null,
    { capabilities: ["workspaces-v1"] },
    { capabilities: ["workspaces-v1"], workspaces: [{ id: "", name: "x" }] },
    { capabilities: [] },
  ]) {
    answering(health);
    await expect(readInstance(kernel)).rejects.toThrow();
  }
});

test("a workspace's base and an address's kernel and workspace", () => {
  expect(workspaceBase(kernel, "ws a")).toBe(`${kernel}/w/ws%20a`);
  expect(workspaceBase(`${kernel}/w/ws-a`, "ws-b")).toBe(`${kernel}/w/ws-b`);
  expect(workspaceAddress(`${kernel}/w/ws%20a`)).toEqual({
    kernel,
    workspaceId: "ws a",
  });
  expect(workspaceAddress(kernel)).toEqual({ kernel, workspaceId: undefined });
});

test("the workspace opened is the one chosen last while it is served, else the only one", () => {
  const instance = (ids: string[]) => ({
    kernel,
    multi: true,
    workspaces: ids.map((id) => ({
      id,
      name: id,
      base: workspaceBase(kernel, id),
    })),
  });
  expect(pickWorkspace(instance(["a", "b"]), "b")?.id).toBe("b");
  expect(pickWorkspace(instance(["a", "b"]), "gone")).toBeUndefined();
  expect(pickWorkspace(instance(["a", "b"]))).toBeUndefined();
  expect(pickWorkspace(instance(["a"]), "gone")?.id).toBe("a");
});

test("the workspace chosen is remembered per kernel, and nothing breaks without storage", () => {
  expect(rememberedWorkspace(kernel)).toBeUndefined();
  rememberWorkspace(kernel, "a");
  const kept = new Map<string, string>();
  (globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (key: string) => kept.get(key) ?? null,
    setItem: (key: string, value: string) => void kept.set(key, value),
  };
  rememberWorkspace(`${kernel}/w/a`, "b");
  expect(rememberedWorkspace(kernel)).toBe("b");
  expect(rememberedWorkspace("http://192.168.1.11:4310")).toBeUndefined();
});

test("an invitation link names the workspace's base, and its own link reads back", () => {
  const base = `${kernel}/w/ws-a`;
  expect(readInviteLink(inviteLink(base, "t 1"))).toEqual({
    kernel: base,
    invite: "t 1",
  });
  expect(readInviteLink(`${kernel}/join?invite=t2`)).toEqual({
    kernel,
    invite: "t2",
  });
  expect(readInviteLink(`${kernel}/w/ws-a/other?invite=t3`)).toBeUndefined();
});

test("calls and a piece's own file go under the workspace's base", async () => {
  const base = `${kernel}/w/ws-a`;
  const asked: string[] = [];
  setKernelFetch(async (url) => {
    asked.push(url);
    return Response.json({ url: "/api/extension-ui/k1/index.html" });
  });
  await request(base, "/workspace");
  const piece: UiPiece = {
    extension: "aspen.board",
    space: "settings",
    name: "options",
    title: "Options",
    view: { kind: "web", entry: "index.html" },
  };
  expect(await pieceUrl(piece, base)).toBe(
    `${base}/api/extension-ui/k1/index.html`,
  );
  expect(asked).toEqual([
    `${base}/api/workspace`,
    `${base}/api/extensions/aspen.board/ui`,
  ]);
});
