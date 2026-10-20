import { afterEach, expect, test } from "bun:test";
import { parseEvent } from "./chat";
import { setKernelFetch } from "./client";
import {
  answerBridge,
  resultLine,
  runPieceAction,
  uiPieces,
  validTree,
  webPieceUrl,
  withContext,
  withoutContext,
} from "./extension-ui";
import type { UiPiece } from "./extension-ui";
import type { Extension } from "./extensions";

afterEach(() => setKernelFetch());

const kernel = "http://192.0.2.4:4400";

test("a described view is checked part by part and comes back in the client's terms", () => {
  expect(
    validTree({
      type: "stack",
      children: [
        { type: "heading", text: "Board" },
        { type: "text", text: "2 open", tone: "muted" },
        {
          type: "list",
          items: [
            {
              title: "Fix the invites",
              badge: "open",
              action: { name: "open", input: { id: 1 } },
            },
            { title: "Write the notes" },
          ],
        },
        {
          type: "table",
          columns: [
            { key: "name", title: "Name" },
            { key: "count", title: "Count" },
          ],
          rows: [
            { name: "aspen", count: 3, extra: "left out" },
            { name: "birch" },
          ],
        },
        {
          type: "button",
          title: "Archive",
          action: { name: "archive" },
          tone: "danger",
          confirm: true,
        },
        { type: "form", action: "add", submit: "Add" },
      ],
    }),
  ).toEqual({
    tree: {
      type: "stack",
      direction: "column",
      children: [
        { type: "heading", text: "Board" },
        { type: "text", text: "2 open", tone: "muted" },
        {
          type: "list",
          items: [
            {
              title: "Fix the invites",
              subtitle: undefined,
              badge: "open",
              action: { name: "open", input: { id: 1 } },
            },
            {
              title: "Write the notes",
              subtitle: undefined,
              badge: undefined,
              action: undefined,
            },
          ],
        },
        {
          type: "table",
          columns: [
            { key: "name", title: "Name" },
            { key: "count", title: "Count" },
          ],
          rows: [
            { name: "aspen", count: "3" },
            { name: "birch", count: "" },
          ],
        },
        {
          type: "button",
          title: "Archive",
          action: { name: "archive", input: {} },
          tone: "danger",
          confirm: "Archive?",
        },
        { type: "form", action: "add", submit: "Add", values: {} },
      ],
    },
  });
});

test("a part the client doesn't know is left out, and a broken one stops the view with why", () => {
  expect(
    validTree({
      type: "stack",
      children: [{ type: "chart" }, { type: "divider" }],
    }),
  ).toEqual({
    tree: {
      type: "stack",
      direction: "column",
      children: [{ type: "divider" }],
    },
  });
  expect(validTree({ type: "chart" }).error).toBeString();
  expect(
    validTree({ type: "list", items: [{ subtitle: "no title" }] }).error,
  ).toBe("This view can't be shown: a list item has no text.");
  // An image is drawn from the web or inline, never from the device.
  expect(
    validTree({ type: "image", src: "file:///etc/hosts", alt: "x" }).error,
  ).toBeString();
  expect(
    validTree({ type: "image", src: "https://example.test/a.png", alt: "A" })
      .tree,
  ).toBeDefined();
  let deep: unknown = { type: "divider" };
  for (let i = 0; i < 20; i++) deep = { type: "stack", children: [deep] };
  expect(validTree(deep).error).toBe(
    "This view can't be shown: it is nested too deeply.",
  );
});

const extension = (
  id: string,
  enabled: boolean,
  ui: Omit<UiPiece, "extension">[],
) => ({ id, enabled, contributes: { ui } }) as unknown as Extension;

test("a space shows the pieces of enabled extensions, each with its extension", () => {
  const board = {
    space: "page",
    name: "board",
    title: "Board",
    view: { kind: "described", action: "board" },
  } as const;
  const panel = {
    space: "session",
    name: "panel",
    title: "Panel",
    view: { kind: "native" },
  } as const;
  expect(
    uiPieces(
      [
        extension("aspen.board", true, [board, panel]),
        extension("birch.notes", false, [{ ...board, name: "notes" }]),
      ],
      "page",
    ),
  ).toEqual([{ ...board, extension: "aspen.board" }]);
});

test("an action gets the place it runs from only where its input asks for it, and a form never asks it", () => {
  const schema = {
    type: "object",
    properties: { session_id: { type: "string" }, title: { type: "string" } },
    required: ["session_id", "title"],
  };
  const context = { session_id: "s1", conversation_id: "c1" };
  expect(withContext({ title: "A" }, schema, context)).toEqual({
    session_id: "s1",
    title: "A",
  });
  expect(withContext({}, undefined, context)).toEqual({});
  expect(withoutContext(schema, context)).toEqual({
    type: "object",
    properties: { title: { type: "string" } },
    required: ["title"],
  });
});

test("a message's menu piece runs its action on the message, and its result reads in one line", async () => {
  const asked: { url: string; body: unknown }[] = [];
  setKernelFetch(async (url, init) => {
    asked.push({ url: String(url), body: JSON.parse(String(init?.body)) });
    return Response.json({ result: { saved: true } });
  });
  const piece: UiPiece = {
    extension: "aspen.board",
    space: "message",
    name: "task",
    title: "Make a task",
    view: { kind: "action", action: "from_message" },
  };
  const result = await runPieceAction(
    piece,
    { conversation_id: "c1", message_id: "m1" },
    kernel,
  );
  expect(asked).toEqual([
    {
      url: `${kernel}/api/ext/aspen.board/from_message`,
      body: { conversation_id: "c1", message_id: "m1" },
    },
  ]);
  expect(resultLine(result)).toBe('{"saved":true}');
  expect(resultLine(null)).toBe("Done");
  expect(resultLine({ text: "Pinned" })).toBe("Pinned");
  expect(resultLine({ message: "Saved", id: 3 })).toBe("Saved");
  expect(resultLine("x".repeat(300))).toHaveLength(200);
});

test("an extension's events and trees are each their own notice", () => {
  const encode = (value: unknown) =>
    new TextEncoder().encode(JSON.stringify(value));
  const first = parseEvent(
    encode({ type: "extension.event", event: "aspen.board/changed" }),
  );
  const second = parseEvent(
    encode({ type: "extension.event", event: "aspen.board/changed" }),
  );
  expect(first?.event_id).toStartWith("extension.event:aspen.board/changed:");
  expect(first?.event_id).not.toBe(second?.event_id);
  const view = parseEvent(
    encode({
      type: "extension.view",
      extension: "aspen.board",
      name: "board",
      context: {},
      tree: {},
    }),
  );
  expect(view?.event_id).toStartWith("extension.view:aspen.board:board:");
});

test("a web piece opens at the address the kernel gives, and its tools/call runs an action", async () => {
  setKernelFetch(async (url, init) => {
    expect(String(url)).toEndWith("/api/extensions/aspen.board/ui");
    expect(JSON.parse(String(init?.body))).toEqual({ entry: "index.html" });
    return Response.json({ url: "/api/extension-ui/k1/index.html" });
  });
  const piece: UiPiece = {
    extension: "aspen.board",
    space: "settings",
    name: "options",
    title: "Options",
    view: { kind: "web", entry: "index.html" },
  };
  expect(await webPieceUrl(piece, kernel)).toBe(
    `${kernel}/api/extension-ui/k1/index.html`,
  );
  // On the web the kernel is the page's origin: the path is the address.
  expect(await webPieceUrl(piece, "")).toBe("/api/extension-ui/k1/index.html");
  const ran: unknown[] = [];
  const call = async (name: string, input: Record<string, unknown>) => {
    ran.push([name, input]);
    if (name === "fail") throw new Error("Nothing to pin");
    return { pinned: true };
  };
  expect(
    await answerBridge(
      {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "pin", arguments: { id: 3 } },
      },
      call,
    ),
  ).toEqual({ jsonrpc: "2.0", id: 1, result: { pinned: true } });
  expect(
    await answerBridge(
      { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "fail" } },
      call,
    ),
  ).toEqual({
    jsonrpc: "2.0",
    id: 2,
    error: { code: -32000, message: "Nothing to pin" },
  });
  expect(
    (await answerBridge({ jsonrpc: "2.0", id: 3, method: "tools/list" }, call))
      ?.error,
  ).toBeDefined();
  // A notice asks nothing, and nothing is answered.
  expect(
    await answerBridge({ jsonrpc: "2.0", method: "ui/ready" }, call),
  ).toBeUndefined();
  expect(ran).toEqual([
    ["pin", { id: 3 }],
    ["fail", {}],
  ]);
});
