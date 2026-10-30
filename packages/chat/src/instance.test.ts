import { afterEach, expect, test } from "bun:test";
import { request, setKernelFetch } from "./client";
import { pieceUrl } from "./extension-ui";
import type { UiPiece } from "./extension-ui";
import {
  pickWorkspace,
  rememberedWorkspace,
  rememberWorkspace,
  workspaceAddress,
  workspaceBase,
  workspaceSummary,
} from "./instance";
import { inviteLink, readInviteLink } from "./people";

const kernel = "http://192.168.1.10:4310";

afterEach(() => {
  setKernelFetch();
  delete (globalThis as { localStorage?: unknown }).localStorage;
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

test("the workspace opened is the one chosen last while it is there, else the only one", () => {
  const workspaces = (ids: string[]) =>
    ids.map((id) => ({
      id,
      name: id,
      base: workspaceBase(kernel, id),
      owner: true,
    }));
  expect(pickWorkspace(workspaces(["a", "b"]), "b")?.id).toBe("b");
  expect(pickWorkspace(workspaces(["a", "b"]), "gone")).toBeUndefined();
  expect(pickWorkspace(workspaces(["a", "b"]))).toBeUndefined();
  expect(pickWorkspace(workspaces(["a"]), "gone")?.id).toBe("a");
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

test("what waits in another workspace: its pending requests and its chats, not threads, with unread messages", async () => {
  const base = `${kernel}/w/ws-b`;
  const asked: string[] = [];
  setKernelFetch(async (url) => {
    asked.push(url);
    return url.endsWith("/chat/approvals")
      ? Response.json({
          approvals: [
            { id: "a1", status: "pending" },
            { id: "a2", status: "decided" },
            { id: "a3", status: "pending" },
          ],
        })
      : Response.json({
          conversations: [
            { id: "c1", last_seq: 5, read_seq: 5 },
            { id: "c2", last_seq: 7, read_seq: 4 },
            { id: "c3", last_seq: 2 },
            { id: "t1", kind: "thread", last_seq: 9, read_seq: 1 },
          ],
        });
  });
  expect(await workspaceSummary(base)).toEqual({ requests: 2, unread: 2 });
  expect(asked.sort()).toEqual([
    `${base}/api/chat/approvals`,
    `${base}/api/conversations`,
  ]);
});
