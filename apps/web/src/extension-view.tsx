import { useEffect, useRef, useState } from "react";
import type { ComponentType, ReactNode } from "react";
import {
  BlocksIcon,
  EllipsisIcon,
  ChartBarIcon,
  FileTextIcon,
  FolderIcon,
  KanbanIcon,
  ListChecksIcon,
  type LucideIcon,
  SettingsIcon,
  SparklesIcon,
} from "lucide-react";
import { useParams } from "react-router";
import {
  answerBridge,
  errorMessage,
  resultLine,
  runPieceAction,
  useExtensionView,
  useUiPieces,
  webPieceUrl,
  withoutContext,
} from "@zerolux/chat";
import type { UiContext, UiNode, UiPiece } from "@zerolux/chat";
import { cn } from "cn";
import { ActionForm } from "./ActionForm";
import { MessageText } from "@/components/message-text";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Separator } from "@/components/ui/separator";

/** A piece's icon by its name; an unknown name shows as an extension. */
const named: Record<string, LucideIcon> = {
  folder: FolderIcon,
  kanban: KanbanIcon,
  "list-checks": ListChecksIcon,
  "file-text": FileTextIcon,
  "chart-bar": ChartBarIcon,
  settings: SettingsIcon,
  sparkles: SparklesIcon,
};
export const pieceIcon = (piece: UiPiece) =>
  (piece.icon && named[piece.icon]) || BlocksIcon;

/** The app's own components for official extensions' native pieces, by `<extension>/<name>`. */
export const nativeViews: Record<
  string,
  ComponentType<{ context: UiContext }>
> = {};

type Run = (name: string, input: Record<string, unknown>) => void;

/** One part of a view an extension describes, drawn with the app's components. */
export function Part({
  node,
  run,
  busy,
  form,
}: {
  node: UiNode;
  run: Run;
  busy: boolean;
  form: (node: Extract<UiNode, { type: "form" }>) => ReactNode;
}) {
  const parts = (children: UiNode[]) =>
    children.map((child, i) => (
      <Part key={i} node={child} run={run} busy={busy} form={form} />
    ));
  switch (node.type) {
    case "stack":
      return (
        <div
          className={cn(
            "flex gap-3",
            node.direction === "row"
              ? "flex-row flex-wrap items-center"
              : "flex-col",
          )}
        >
          {parts(node.children)}
        </div>
      );
    case "heading":
      return <h3 className="text-sm font-medium">{node.text}</h3>;
    case "text":
      return (
        <p
          className={cn(
            "text-sm",
            node.tone === "muted" && "text-muted-foreground",
            node.tone === "danger" && "text-destructive",
          )}
        >
          {node.text}
        </p>
      );
    case "markdown":
      return <MessageText text={node.text} />;
    case "badge":
      return (
        <Badge variant="outline" className="self-start">
          {node.text}
        </Badge>
      );
    case "divider":
      return <Separator />;
    case "empty":
      return <p className="text-sm text-muted-foreground">{node.text}</p>;
    case "image":
      return (
        <img
          src={node.src}
          alt={node.alt}
          className="max-h-80 max-w-full rounded-md border object-contain"
        />
      );
    case "list":
      return (
        <ul className="flex flex-col divide-y rounded-md border">
          {node.items.map((item, i) => {
            const body = (
              <>
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate text-sm">{item.title}</span>
                  {item.subtitle && (
                    <span className="truncate text-xs text-muted-foreground">
                      {item.subtitle}
                    </span>
                  )}
                </span>
                {item.badge && <Badge variant="outline">{item.badge}</Badge>}
              </>
            );
            const action = item.action;
            return (
              <li key={i}>
                {action ? (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => run(action.name, action.input)}
                    className="flex w-full items-center gap-3 px-3 py-2 text-left transition-colors hover:bg-accent disabled:opacity-60"
                  >
                    {body}
                  </button>
                ) : (
                  <div className="flex items-center gap-3 px-3 py-2">
                    {body}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      );
    case "table":
      return (
        <div className="overflow-x-auto rounded-md border">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-left text-xs text-muted-foreground">
              <tr>
                {node.columns.map((column) => (
                  <th key={column.key} className="px-3 py-2 font-medium">
                    {column.title}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y">
              {node.rows.map((row, i) => (
                <tr key={i}>
                  {node.columns.map((column) => (
                    <td key={column.key} className="px-3 py-2">
                      {row[column.key]}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    case "button":
      return (
        <ConfirmButton
          title={node.title}
          tone={node.tone}
          confirm={node.confirm}
          busy={busy}
          go={() => run(node.action.name, node.action.input)}
        />
      );
    case "form":
      return form(node);
  }
}

/** A button of a view: asked first when the extension says so. */
function ConfirmButton({
  title,
  tone,
  confirm,
  busy,
  go,
}: {
  title: string;
  tone?: "primary" | "danger";
  confirm?: string;
  busy: boolean;
  go: () => void;
}) {
  const [asking, setAsking] = useState(false);
  const variant =
    tone === "danger"
      ? "destructive"
      : tone === "primary"
        ? "default"
        : "outline";
  if (asking)
    return (
      <div className="flex flex-wrap items-center gap-2 rounded-md bg-attention/10 p-2">
        <span className="text-sm">{confirm}</span>
        <Button
          size="sm"
          variant={variant}
          disabled={busy}
          onClick={() => {
            setAsking(false);
            go();
          }}
        >
          {title}
        </Button>
        <Button size="sm" variant="outline" onClick={() => setAsking(false)}>
          Cancel
        </Button>
      </div>
    );
  return (
    <Button
      size="sm"
      variant={variant}
      disabled={busy}
      className="self-start"
      onClick={() => (confirm ? setAsking(true) : go())}
    >
      {title}
    </Button>
  );
}

/** A described or remote view: its tree, drawn again after each action it runs. */
function DescribedView({
  piece,
  context,
}: {
  piece: UiPiece;
  context: UiContext;
}) {
  const view = useExtensionView(piece, context);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState("");
  // A form starts empty again once its action is done.
  const [done, setDone] = useState(0);
  const run: Run = (name, input) => {
    setBusy(true);
    setFailed("");
    void view
      .run(name, input)
      .then(() => setDone((count) => count + 1))
      .catch((error: unknown) => setFailed(errorMessage(error)))
      .finally(() => setBusy(false));
  };
  const error = failed || view.error;
  return (
    <div className="flex flex-col gap-3">
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      {view.tree ? (
        <Part
          node={view.tree}
          run={run}
          busy={busy}
          form={(node) => {
            const schema = view.schemaOf(node.action);
            return (
              <ActionForm
                key={done}
                schema={schema && withoutContext(schema, context)}
                value={node.values}
                submit={node.submit}
                busy={busy}
                run={(input) => run(node.action, input)}
              />
            );
          }}
        />
      ) : (
        view.loading && (
          <p className="text-sm text-muted-foreground">Loading…</p>
        )
      )}
    </div>
  );
}

/**
 * An extension's own page from its `ui/` folder, isolated in a frame with no access to this
 * app's origin. It runs the extension's actions by asking, as MCP Apps do: JSON-RPC over
 * `postMessage`, answered as every client answers it.
 */
function WebView({ piece, context }: { piece: UiPiece; context: UiContext }) {
  const frame = useRef<HTMLIFrameElement>(null);
  const { run } = useExtensionView(piece, context);
  const [opened, setOpened] = useState<{ url?: string; error?: string }>();
  useEffect(() => {
    let live = true;
    webPieceUrl(piece).then(
      (url) => live && setOpened({ url }),
      (error: unknown) => live && setOpened({ error: errorMessage(error) }),
    );
    return () => {
      live = false;
    };
  }, [piece]);
  useEffect(() => {
    const listen = async (event: MessageEvent) => {
      const own = frame.current?.contentWindow;
      if (!own || event.source !== own) return;
      const reply = await answerBridge(event.data, run);
      // The page has no origin of its own to name.
      if (reply) own.postMessage(reply, "*");
    };
    window.addEventListener("message", listen);
    return () => window.removeEventListener("message", listen);
  }, [run]);
  if (opened?.error)
    return (
      <p role="alert" className="text-sm text-destructive">
        {opened.error}
      </p>
    );
  if (!opened?.url)
    return <p className="text-sm text-muted-foreground">Loading…</p>;
  return (
    <iframe
      ref={frame}
      title={piece.title}
      sandbox="allow-scripts allow-forms"
      src={opened.url}
      className="min-h-96 w-full flex-1 rounded-md border bg-background"
    />
  );
}

/** A piece of an extension's interface where it shows, drawn the way it says. */
export function ExtensionView({
  piece,
  context,
}: {
  piece: UiPiece;
  context: UiContext;
}) {
  const kind = piece.view.kind;
  if (kind === "native") {
    const Native = nativeViews[`${piece.extension}/${piece.name}`];
    return Native ? <Native context={context} /> : null;
  }
  if (kind === "web") return <WebView piece={piece} context={context} />;
  if (kind === "described" || kind === "remote")
    return <DescribedView piece={piece} context={context} />;
  return null;
}

/** A page an extension brings, found by its address: `/x/<extension>/<name>`. */
export function ExtensionPage() {
  const { extension, name } = useParams();
  const piece = useUiPieces("page").find(
    (one) => one.extension === extension && one.name === name,
  );
  if (!piece)
    return <p className="text-sm text-muted-foreground">No such page.</p>;
  return (
    <>
      <h1 className="text-2xl font-semibold tracking-tight">{piece.title}</h1>
      <ExtensionView piece={piece} context={{}} />
    </>
  );
}

/** A message's menu of what extensions do with it: each runs on the message, its result in a line. */
export function MessageActions({
  pieces,
  context,
}: {
  pieces: UiPiece[];
  context: Required<Pick<UiContext, "conversation_id" | "message_id">>;
}) {
  const [running, setRunning] = useState(false);
  const [line, setLine] = useState<{ text: string; failed: boolean }>();
  if (!pieces.length) return null;
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger
          disabled={running}
          render={
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              aria-label="Message actions"
              title="Message actions"
              className="text-faint opacity-0 transition-opacity group-hover/message:opacity-100 focus-visible:opacity-100 aria-expanded:opacity-100"
            />
          }
        >
          <EllipsisIcon />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-52">
          {pieces.map((piece) => {
            const Icon = pieceIcon(piece);
            return (
              <DropdownMenuItem
                key={`${piece.extension}/${piece.name}`}
                onClick={() => {
                  setRunning(true);
                  setLine(undefined);
                  runPieceAction(piece, context)
                    .then(
                      (result) =>
                        setLine({ text: resultLine(result), failed: false }),
                      (error: unknown) =>
                        setLine({ text: errorMessage(error), failed: true }),
                    )
                    .finally(() => setRunning(false));
                }}
              >
                <Icon />
                {piece.title}
              </DropdownMenuItem>
            );
          })}
        </DropdownMenuContent>
      </DropdownMenu>
      {line && (
        <p
          role={line.failed ? "alert" : "status"}
          className={cn(
            "basis-full text-xs",
            line.failed ? "text-destructive" : "text-muted-foreground",
          )}
        >
          {line.text}
        </p>
      )}
    </>
  );
}
