import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { JsonSchema } from "./action-form";
import { errorMessage, kernelUrl, request } from "./client";
import { runAction, useActions, useExtensions } from "./extensions";
import type { Extension, ExtensionAction } from "./extensions";

/** Where in the clients an extension's piece of interface shows. */
export type UiSpace = "page" | "session" | "chat" | "message" | "settings";

/** An action a view runs, with its input. */
export interface UiAction {
  name: string;
  input: Record<string, unknown>;
}

/** How a piece is drawn. */
export type UiView =
  /** The client's own component, registered as `<extension>/<name>`. */
  | { kind: "native" }
  /** A tree the action returns, drawn again after each action and at `refresh_on`. */
  | { kind: "described"; action: string; refresh_on?: string[] }
  /** As `described`, and the extension sends new trees itself. */
  | { kind: "remote"; action: string; refresh_on?: string[] }
  /** The extension's own page from `ui/`, isolated. */
  | { kind: "web"; entry: string }
  /** In a message's menu: the action runs on the message. */
  | { kind: "action"; action: string };

/** A piece of interface an extension brings into a space. */
export interface UiPiece {
  extension: string;
  space: UiSpace;
  name: string;
  title: string;
  icon?: string;
  view: UiView;
}

/** Where a piece shows, as its actions read it. */
export interface UiContext {
  session_id?: string;
  conversation_id?: string;
  message_id?: string;
}

/** A part of a view an extension describes. */
export type UiNode =
  | { type: "stack"; direction: "row" | "column"; children: UiNode[] }
  | { type: "heading"; text: string }
  | { type: "text"; text: string; tone?: "muted" | "danger" }
  | { type: "markdown"; text: string }
  | { type: "badge"; text: string }
  | { type: "divider" }
  | { type: "empty"; text: string }
  | { type: "image"; src: string; alt: string }
  | {
      type: "list";
      items: {
        title: string;
        subtitle?: string;
        badge?: string;
        action?: UiAction;
      }[];
    }
  | {
      type: "table";
      columns: { key: string; title: string }[];
      rows: Record<string, string>[];
    }
  | {
      type: "button";
      title: string;
      action: UiAction;
      tone?: "primary" | "danger";
      /** Asked before it runs. */
      confirm?: string;
    }
  | {
      type: "form";
      /** The action it runs; its fields come from the action's input. */
      action: string;
      submit: string;
      values: Record<string, unknown>;
    };

// How deep and how large a view may be before it is refused.
const DEEPEST = 16;
const LARGEST = 2000;

class Invalid extends Error {}

/**
 * An extension's view as its parts, checked one by one; or why it can't be drawn, in a
 * sentence. A part the client doesn't know is left out, so a newer extension still shows.
 */
export function validTree(
  json: unknown,
): { tree: UiNode; error?: undefined } | { tree?: undefined; error: string } {
  let parts = 0;
  const record = (value: unknown, what: string) => {
    if (typeof value !== "object" || value === null || Array.isArray(value))
      throw new Invalid(`${what} is not an object`);
    return value as Record<string, unknown>;
  };
  const text = (value: unknown, what: string) => {
    if (typeof value !== "string") throw new Invalid(`${what} has no text`);
    return value;
  };
  const optional = (value: unknown, what: string) =>
    value === undefined || value === null ? undefined : text(value, what);
  const list = (value: unknown, what: string) => {
    if (!Array.isArray(value)) throw new Invalid(`${what} is not a list`);
    return value as unknown[];
  };
  const action = (value: unknown, what: string): UiAction => {
    const a = record(value, what);
    return {
      name: text(a.name, `${what}'s name`),
      input: a.input === undefined ? {} : record(a.input, `${what}'s input`),
    };
  };
  const node = (value: unknown, depth: number): UiNode | undefined => {
    if (depth > DEEPEST) throw new Invalid("it is nested too deeply");
    if (++parts > LARGEST) throw new Invalid("it has too many parts");
    const n = record(value, "a part");
    switch (n.type) {
      case "stack":
        return {
          type: "stack",
          direction: n.direction === "row" ? "row" : "column",
          children: list(n.children, "a stack's children").flatMap(
            (child) => node(child, depth + 1) ?? [],
          ),
        };
      case "heading":
      case "markdown":
      case "badge":
      case "empty":
        return { type: n.type, text: text(n.text, `a ${n.type}`) };
      case "text":
        return {
          type: "text",
          text: text(n.text, "a text"),
          ...(n.tone === "muted" || n.tone === "danger"
            ? { tone: n.tone }
            : {}),
        };
      case "divider":
        return { type: "divider" };
      case "image": {
        const src = text(n.src, "an image's source");
        // Drawn from the web or carried inline: never a file of the device.
        if (!/^(https:|data:image\/)/.test(src))
          throw new Invalid("an image's source is not https or data");
        return { type: "image", src, alt: text(n.alt, "an image's alt") };
      }
      case "list":
        return {
          type: "list",
          items: list(n.items, "a list's items").map((value) => {
            const item = record(value, "a list item");
            return {
              title: text(item.title, "a list item"),
              subtitle: optional(item.subtitle, "a list item's subtitle"),
              badge: optional(item.badge, "a list item's badge"),
              action:
                item.action === undefined
                  ? undefined
                  : action(item.action, "a list item's action"),
            };
          }),
        };
      case "table": {
        const columns = list(n.columns, "a table's columns").map((value) => {
          const column = record(value, "a table column");
          return {
            key: text(column.key, "a table column's key"),
            title: text(column.title, "a table column"),
          };
        });
        return {
          type: "table",
          columns,
          rows: list(n.rows, "a table's rows").map((value) => {
            const row = record(value, "a table row");
            return Object.fromEntries(
              columns.map(({ key }) => [
                key,
                row[key] === undefined || row[key] === null
                  ? ""
                  : String(row[key]),
              ]),
            );
          }),
        };
      }
      case "button": {
        const title = text(n.title, "a button");
        return {
          type: "button",
          title,
          action: action(n.action, "a button's action"),
          ...(n.tone === "primary" || n.tone === "danger"
            ? { tone: n.tone }
            : {}),
          ...(n.confirm === true
            ? { confirm: `${title}?` }
            : typeof n.confirm === "string"
              ? { confirm: n.confirm }
              : {}),
        };
      }
      case "form":
        return {
          type: "form",
          action: text(n.action, "a form's action"),
          submit: text(n.submit, "a form's button"),
          values:
            n.values === undefined ? {} : record(n.values, "a form's values"),
        };
      default:
        return undefined;
    }
  };
  try {
    const tree = node(json, 0);
    if (!tree) throw new Invalid("it is no part the app knows");
    return { tree };
  } catch (error) {
    if (!(error instanceof Invalid)) throw error;
    return { error: `This view can't be shown: ${error.message}.` };
  }
}

/** The pieces the workspace's enabled extensions bring into a space, in their order. */
export const uiPieces = (extensions: Extension[], space: UiSpace): UiPiece[] =>
  extensions
    .filter((extension) => extension.enabled)
    .flatMap((extension) =>
      (extension.contributes?.ui ?? [])
        .filter((piece) => piece.space === space)
        .map((piece) => ({ ...piece, extension: extension.id })),
    );

/** The pieces for a space, read again whenever extensions change. */
export function useUiPieces(
  space: UiSpace,
  kernel = kernelUrl(),
  enabled = true,
) {
  const { extensions } = useExtensions(kernel, enabled);
  return useMemo(() => uiPieces(extensions ?? [], space), [extensions, space]);
}

const keys = (context: UiContext) =>
  Object.entries(context).filter(([, value]) => value !== undefined) as [
    keyof UiContext,
    string,
  ][];

/** An action's input with the place it runs from, where its input asks for it. */
export const withContext = (
  input: Record<string, unknown>,
  schema: JsonSchema | undefined,
  context: UiContext,
) => ({
  ...Object.fromEntries(
    keys(context).filter(([key]) => schema?.properties?.[key] !== undefined),
  ),
  ...input,
});

/** An action's input for a form: what the place fills in is not asked. */
export function withoutContext(
  schema: JsonSchema,
  context: UiContext,
): JsonSchema {
  const known = new Set(keys(context).map(([key]) => key as string));
  if (!schema.properties || !known.size) return schema;
  return {
    ...schema,
    properties: Object.fromEntries(
      Object.entries(schema.properties).filter(([key]) => !known.has(key)),
    ),
    required: schema.required?.filter((key) => !known.has(key)),
  };
}

/** Runs a message's menu piece on the message: its result. */
export const runPieceAction = (
  piece: UiPiece,
  context: UiContext,
  kernel = kernelUrl(),
) =>
  piece.view.kind === "action"
    ? runAction(
        piece.extension,
        piece.view.action,
        { ...context } as Record<string, unknown>,
        kernel,
      )
    : Promise.reject(new Error(`${piece.title} is not an action`));

/**
 * A web piece's page: an address the kernel opens for an hour, to that extension's `ui/`
 * folder only. Shown isolated, `sandbox="allow-scripts allow-forms"`, never same-origin.
 */
export async function webPieceUrl(piece: UiPiece, kernel = kernelUrl()) {
  if (piece.view.kind !== "web")
    throw new Error(`${piece.title} is not a web page`);
  const { url } = await request<{ url: string }>(
    kernel,
    `/extensions/${encodeURIComponent(piece.extension)}/ui`,
    { entry: piece.view.entry },
  );
  return new URL(url, kernel).toString();
}

/** The app's answer to a web piece, as JSON-RPC. */
export interface BridgeReply {
  jsonrpc: "2.0";
  id: string | number;
  result?: unknown;
  error?: { code: number; message: string };
}

/**
 * A web piece's request to the app, as MCP Apps ask: `tools/call {name, arguments}` runs one
 * of its extension's actions. The JSON-RPC reply to post back, or nothing for a message
 * that asks nothing.
 */
export async function answerBridge(
  message: unknown,
  call: (name: string, input: Record<string, unknown>) => Promise<unknown>,
): Promise<BridgeReply | undefined> {
  if (typeof message !== "object" || message === null) return undefined;
  const { id, method, params } = message as {
    id?: string | number;
    method?: unknown;
    params?: { name?: unknown; arguments?: unknown };
  };
  if (id === undefined) return undefined;
  const reply = (
    body: Pick<BridgeReply, "result"> | Pick<BridgeReply, "error">,
  ): BridgeReply => ({ jsonrpc: "2.0", id, ...body });
  if (method !== "tools/call" || typeof params?.name !== "string")
    return reply({
      error: { code: -32601, message: "Only tools/call is known" },
    });
  const input =
    typeof params.arguments === "object" && params.arguments !== null
      ? (params.arguments as Record<string, unknown>)
      : {};
  try {
    return reply({ result: await call(params.name, input) });
  } catch (error) {
    return reply({ error: { code: -32000, message: errorMessage(error) } });
  }
}

/** What an action gave back, in one line. */
export function resultLine(value: unknown) {
  if (value === undefined || value === null || value === "") return "Done";
  const line = typeof value === "string" ? value : JSON.stringify(value);
  return line.length > 200 ? `${line.slice(0, 199)}…` : line;
}

/** An extension's event, by its full name, or a new tree it sends for one of its views. */
export type UiNotice =
  | { type: "extension.event"; event: string }
  | {
      type: "extension.view";
      extension: string;
      name: string;
      context: UiContext;
      tree: unknown;
    };

const listeners = new Set<(notice: UiNotice) => void>();

/** Every shown view hears an extension's event or tree. */
export function uiNotice(notice: UiNotice) {
  listeners.forEach((listen) => listen(notice));
}

const sameContext = (a: UiContext, b: UiContext) =>
  (a.session_id ?? "") === (b.session_id ?? "") &&
  (a.conversation_id ?? "") === (b.conversation_id ?? "") &&
  (a.message_id ?? "") === (b.message_id ?? "");

/**
 * A described or remote view where it shows: its tree, read by running its action with the
 * place it shows in, and read again after each action it runs and at its `refresh_on`
 * events; a remote one also takes the trees its extension sends.
 */
export function useExtensionView(
  piece: UiPiece,
  context: UiContext,
  kernel = kernelUrl(),
) {
  const { actions } = useActions(kernel);
  const [state, setState] = useState<{
    tree?: UiNode;
    error: string;
    loading: boolean;
  }>({ error: "", loading: true });
  const view = piece.view;
  const action =
    view.kind === "described" || view.kind === "remote"
      ? view.action
      : undefined;
  const refreshOn =
    view.kind === "described" || view.kind === "remote"
      ? (view.refresh_on ?? [])
      : [];
  // The place as text, so a new object for the same place reads nothing again.
  const place = JSON.stringify(context);
  const schemaOf = useCallback(
    (name: string) =>
      actions?.find(
        (a: ExtensionAction) =>
          a.extension === piece.extension && a.name === name,
      )?.input,
    [actions, piece.extension],
  );
  // Only the latest read draws: an earlier one that ends later is dropped.
  const reads = useRef(0);
  const read = useCallback(async () => {
    if (!action) return;
    const at = ++reads.current;
    setState((was) => ({ ...was, loading: true }));
    try {
      const result = await runAction(
        piece.extension,
        action,
        JSON.parse(place) as UiContext as Record<string, unknown>,
        kernel,
      );
      if (at !== reads.current) return;
      const valid = validTree(result);
      setState({ tree: valid.tree, error: valid.error ?? "", loading: false });
    } catch (error) {
      if (at !== reads.current) return;
      setState((was) => ({
        ...was,
        error: errorMessage(error),
        loading: false,
      }));
    }
  }, [piece.extension, action, place, kernel]);
  useEffect(() => void read(), [read]);
  const events = refreshOn.join("\n");
  useEffect(() => {
    const listen = (notice: UiNotice) => {
      if (notice.type === "extension.event") {
        if (events.split("\n").includes(notice.event)) void read();
        return;
      }
      if (
        view.kind === "remote" &&
        notice.extension === piece.extension &&
        notice.name === piece.name &&
        sameContext(notice.context ?? {}, JSON.parse(place) as UiContext)
      ) {
        ++reads.current;
        const valid = validTree(notice.tree);
        setState({
          tree: valid.tree,
          error: valid.error ?? "",
          loading: false,
        });
      }
    };
    listeners.add(listen);
    return () => void listeners.delete(listen);
  }, [events, read, view.kind, piece.extension, piece.name, place]);
  /** Runs one of the extension's actions from the view, then draws it again: its result. */
  const run = useCallback(
    async (name: string, input: Record<string, unknown> = {}) => {
      const result = await runAction(
        piece.extension,
        name,
        withContext(input, schemaOf(name), JSON.parse(place) as UiContext),
        kernel,
      );
      void read();
      return result;
    },
    [piece.extension, schemaOf, place, kernel, read],
  );
  return { ...state, run, schemaOf };
}
