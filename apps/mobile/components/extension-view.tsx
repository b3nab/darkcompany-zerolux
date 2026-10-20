import * as Haptics from "expo-haptics";
import { ChevronRightIcon } from "lucide-react-native";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { ComponentType } from "react";
import {
  ActivityIndicator,
  Alert,
  Image,
  Pressable,
  ScrollView,
  View,
} from "react-native";
import { useCSSVariable } from "uniwind";
import {
  answerBridge,
  errorMessage,
  resultLine,
  runPieceAction,
  useActionForm,
  useExtensionView,
  pieceUrl,
  withoutContext,
} from "@zerolux/chat";
import type {
  JsonSchema,
  UiAction,
  UiContext,
  UiNode,
  UiPiece,
} from "@zerolux/chat";
import { ActionForm } from "@/components/action-form";
import { MessageBody } from "@/components/message-body";
import { NativeView } from "@/components/native-view";
import { Button } from "@/components/ui/button";
import { Text } from "@/components/ui/text";
import { lucideIcon } from "@/components/ui-components";
import WebPiece from "@/components/web-piece";
import { cn } from "@/lib/utils";
import { useSession } from "../src/kernel";

/** The app's own components for official extensions, by `<extension>/<name>`. */
export const nativeViews: Record<
  string,
  ComponentType<{ piece: UiPiece; context: UiContext }>
> = {};

/** A piece's icon by its Lucide name (`kanban-square`); a puzzle when the app has none. */
export const pieceIcon = (piece: UiPiece) => lucideIcon(piece.icon);

/**
 * An extension's piece where it shows: its native view, the view its extension describes,
 * its own page, or nothing when the app can't show it.
 */
export function ExtensionView({
  piece,
  context,
  fill = false,
}: {
  piece: UiPiece;
  context: UiContext;
  /** A web page takes the whole screen, not a frame in a list. */
  fill?: boolean;
}) {
  switch (piece.view.kind) {
    case "native": {
      if (piece.view.entry)
        return <NativeView piece={piece} context={context} />;
      const Native = nativeViews[`${piece.extension}/${piece.name}`];
      return Native ? <Native piece={piece} context={context} /> : null;
    }
    case "described":
    case "remote":
      return <Described piece={piece} context={context} />;
    case "web":
      return <Web piece={piece} context={context} fill={fill} />;
    default:
      return null;
  }
}

/** Runs an action from a part of the view: busy while it runs, and why it failed. */
function useRun(
  run: (name: string, input?: Record<string, unknown>) => Promise<unknown>,
) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  return {
    busy,
    error,
    async go(action: UiAction) {
      setBusy(true);
      setError("");
      try {
        await run(action.name, action.input);
        void Haptics.selectionAsync();
        return true;
      } catch (e) {
        setError(errorMessage(e));
        return false;
      } finally {
        setBusy(false);
      }
    },
  };
}

type Shown = ReturnType<typeof useExtensionView>;

function Described({ piece, context }: { piece: UiPiece; context: UiContext }) {
  const { url } = useSession();
  const view = useExtensionView(piece, context, url);
  const muted = String(useCSSVariable("--color-muted-foreground"));
  if (!view.tree)
    return view.error ? (
      <Text className="text-sm text-destructive">{view.error}</Text>
    ) : (
      <ActivityIndicator size="small" color={muted} className="self-start" />
    );
  return (
    <View className="gap-3">
      {view.error ? (
        <Text className="text-sm text-destructive">{view.error}</Text>
      ) : null}
      <Part node={view.tree} view={view} context={context} />
    </View>
  );
}

/**
 * An extension's own page: the kernel opens its address for an hour, and the page's
 * `tools/call` runs the extension's actions, with the place it shows in.
 */
function Web({
  piece,
  context,
  fill,
}: {
  piece: UiPiece;
  context: UiContext;
  fill: boolean;
}) {
  const { url } = useSession();
  const view = useExtensionView(piece, context, url);
  const muted = String(useCSSVariable("--color-muted-foreground"));
  const [page, setPage] = useState<{ url?: string; error?: string }>({});
  useEffect(() => {
    let shown = true;
    pieceUrl(piece, url).then(
      (address) => shown && setPage({ url: address }),
      (e: unknown) => shown && setPage({ error: errorMessage(e) }),
    );
    return () => {
      shown = false;
    };
  }, [piece, url]);
  const { run } = view;
  const ask = useCallback(
    async (message: string) => {
      const reply = await answerBridge(JSON.parse(message), run);
      return reply ? JSON.stringify(reply) : "";
    },
    [run],
  );
  if (page.error)
    return <Text className="text-sm text-destructive">{page.error}</Text>;
  if (!page.url)
    return (
      <ActivityIndicator size="small" color={muted} className="self-start" />
    );
  return (
    <View
      className={cn(
        "overflow-hidden rounded-md border border-border bg-card",
        fill ? "flex-1" : "h-[420px]",
      )}
    >
      <WebPiece
        url={page.url}
        title={piece.title}
        ask={ask}
        dom={{ style: { flex: 1 }, bounces: false }}
      />
    </View>
  );
}

/** One part of a described view, drawn with the app's own components. */
function Part({
  node,
  view,
  context,
}: {
  node: UiNode;
  view: Shown;
  context: UiContext;
}) {
  switch (node.type) {
    case "stack":
      return (
        <View
          className={
            node.direction === "row"
              ? "flex-row flex-wrap items-center gap-2"
              : "gap-3"
          }
        >
          {node.children.map((child, i) => (
            <Part key={i} node={child} view={view} context={context} />
          ))}
        </View>
      );
    case "heading":
      return <Text className="text-lg font-semibold">{node.text}</Text>;
    case "text":
      return (
        <Text
          className={cn(
            "text-[15px] leading-[22px]",
            node.tone === "muted" && "text-muted-foreground",
            node.tone === "danger" && "text-destructive",
          )}
        >
          {node.text}
        </Text>
      );
    case "markdown":
      return <MessageBody text={node.text} />;
    case "badge":
      return (
        <View className="self-start rounded-sm bg-muted px-2 py-0.5">
          <Text className="font-mono text-[11px] text-muted-foreground">
            {node.text}
          </Text>
        </View>
      );
    case "divider":
      return <View className="h-px bg-border" />;
    case "empty":
      return (
        <Text className="py-6 text-center text-sm text-faint">{node.text}</Text>
      );
    case "image":
      return (
        <Image
          source={{ uri: node.src }}
          accessibilityLabel={node.alt}
          resizeMode="contain"
          className="h-48 w-full rounded-md bg-muted"
        />
      );
    case "list":
      return <List node={node} view={view} />;
    case "table":
      return (
        <ScrollView horizontal showsHorizontalScrollIndicator={false}>
          <View className="overflow-hidden rounded-md border border-border bg-card">
            <View className="flex-row border-b border-border bg-muted">
              {node.columns.map((column) => (
                <Text
                  key={column.key}
                  className="w-32 px-3 py-2 font-mono text-[11px] tracking-wider text-faint uppercase"
                >
                  {column.title}
                </Text>
              ))}
            </View>
            {node.rows.map((row, i) => (
              <View
                key={i}
                className={cn("flex-row", i > 0 && "border-t border-border")}
              >
                {node.columns.map((column) => (
                  <Text key={column.key} className="w-32 px-3 py-2 text-sm">
                    {row[column.key]}
                  </Text>
                ))}
              </View>
            ))}
          </View>
        </ScrollView>
      );
    case "button":
      return <PartButton node={node} view={view} />;
    case "form":
      return <Form node={node} view={view} context={context} />;
  }
}

function List({
  node,
  view,
}: {
  node: Extract<UiNode, { type: "list" }>;
  view: Shown;
}) {
  const faint = String(useCSSVariable("--color-faint"));
  const run = useRun(view.run);
  return (
    <View className="gap-1.5">
      <View className="overflow-hidden rounded-md border border-border bg-card">
        {node.items.map((item, i) => {
          const body = (
            <>
              <View className="min-w-0 flex-1 gap-0.5">
                <Text numberOfLines={2} className="text-[15px]">
                  {item.title}
                </Text>
                {item.subtitle ? (
                  <Text
                    numberOfLines={2}
                    className="text-[13px] text-muted-foreground"
                  >
                    {item.subtitle}
                  </Text>
                ) : null}
              </View>
              {item.badge ? (
                <View className="rounded-sm bg-muted px-2 py-0.5">
                  <Text className="font-mono text-[11px] text-muted-foreground">
                    {item.badge}
                  </Text>
                </View>
              ) : null}
              {item.action ? (
                <ChevronRightIcon color={faint} size={16} strokeWidth={1.5} />
              ) : null}
            </>
          );
          const row = cn(
            "min-h-12 flex-row items-center gap-3 px-3.5 py-2.5",
            i > 0 && "border-t border-border",
          );
          return item.action ? (
            <Pressable
              key={i}
              accessibilityRole="button"
              disabled={run.busy}
              onPress={() => void run.go(item.action!)}
              className={cn(row, "active:bg-accent")}
            >
              {body}
            </Pressable>
          ) : (
            <View key={i} className={row}>
              {body}
            </View>
          );
        })}
      </View>
      {run.error ? (
        <Text className="text-sm text-destructive">{run.error}</Text>
      ) : null}
    </View>
  );
}

function PartButton({
  node,
  view,
}: {
  node: Extract<UiNode, { type: "button" }>;
  view: Shown;
}) {
  const run = useRun(view.run);
  const press = () => {
    if (!node.confirm) return void run.go(node.action);
    Alert.alert(node.confirm, undefined, [
      { text: "Cancel", style: "cancel" },
      {
        text: node.title,
        style: node.tone === "danger" ? "destructive" : "default",
        onPress: () => void run.go(node.action),
      },
    ]);
  };
  return (
    <View className="gap-1.5 self-start">
      <Button
        size="sm"
        variant={
          node.tone === "danger"
            ? "destructive"
            : node.tone === "primary"
              ? "default"
              : "outline"
        }
        disabled={run.busy}
        onPress={press}
      >
        <Text>{node.title}</Text>
      </Button>
      {run.error ? (
        <Text className="text-sm text-destructive">{run.error}</Text>
      ) : null}
    </View>
  );
}

function Form({
  node,
  view,
  context,
}: {
  node: Extract<UiNode, { type: "form" }>;
  view: Shown;
  context: UiContext;
}) {
  const known = view.schemaOf(node.action);
  // Sent, it starts again empty, ready for the next one.
  const [round, setRound] = useState(0);
  // What the place fills in is not asked.
  const schema = useMemo<JsonSchema | undefined>(
    () => (known ? withoutContext(known, context) : undefined),
    [known, context],
  );
  return schema ? (
    <FormFields
      key={`${round}:${JSON.stringify(schema)}`}
      node={node}
      schema={schema}
      view={view}
      sent={() => setRound((was) => was + 1)}
    />
  ) : null;
}

function FormFields({
  node,
  schema,
  view,
  sent,
}: {
  node: Extract<UiNode, { type: "form" }>;
  schema: JsonSchema;
  view: Shown;
  sent: () => void;
}) {
  const form = useActionForm(schema, node.values);
  const run = useRun(view.run);
  return (
    <View className="gap-4">
      <ActionForm {...form} disabled={run.busy} />
      <Button
        disabled={run.busy}
        onPress={() => {
          const input = form.submit();
          if (input)
            void run
              .go({ name: node.action, input })
              .then((ok) => ok && sent());
        }}
        className="self-start"
      >
        <Text>{run.busy ? "Running…" : node.submit}</Text>
      </Button>
      {run.error ? (
        <Text className="text-sm text-destructive">{run.error}</Text>
      ) : null}
    </View>
  );
}

/**
 * A message's pieces under it, once its details are open: each runs its action on the
 * message and says in a line what came back.
 */
export function MessagePieces({
  pieces,
  context,
}: {
  pieces: UiPiece[];
  context: UiContext;
}) {
  const { url } = useSession();
  const [busy, setBusy] = useState<string>();
  const [line, setLine] = useState<{ text: string; error: boolean }>();
  const muted = String(useCSSVariable("--color-muted-foreground"));
  if (!pieces.length) return null;
  return (
    <View className="mt-1.5 gap-1.5">
      <View className="flex-row flex-wrap gap-1.5">
        {pieces.map((piece) => {
          const Icon = pieceIcon(piece);
          const key = `${piece.extension}/${piece.name}`;
          return (
            <Pressable
              key={key}
              accessibilityRole="button"
              disabled={busy !== undefined}
              onPress={() => {
                setBusy(key);
                setLine(undefined);
                runPieceAction(piece, context, url)
                  .then((result) =>
                    setLine({ text: resultLine(result), error: false }),
                  )
                  .catch((e: unknown) =>
                    setLine({ text: errorMessage(e), error: true }),
                  )
                  .finally(() => setBusy(undefined));
              }}
              className="h-8 flex-row items-center gap-1.5 rounded-md border border-border bg-card px-2.5 active:bg-accent"
            >
              {busy === key ? (
                <ActivityIndicator
                  size="small"
                  color={muted}
                  style={{ transform: [{ scale: 0.7 }] }}
                />
              ) : (
                <Icon color={muted} size={14} strokeWidth={1.75} />
              )}
              <Text className="text-[13px]">{piece.title}</Text>
            </Pressable>
          );
        })}
      </View>
      {line ? (
        <Text
          numberOfLines={2}
          className={cn(
            "text-xs",
            line.error ? "text-destructive" : "text-muted-foreground",
          )}
        >
          {line.text}
        </Text>
      ) : null}
    </View>
  );
}
