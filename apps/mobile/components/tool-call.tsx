import { useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { ActivityIndicator, Image, Pressable, View } from "react-native";
import { useRouter } from "expo-router";
import * as Clipboard from "expo-clipboard";
import * as Haptics from "expo-haptics";
import {
  BanIcon,
  BotIcon,
  CheckIcon,
  ChevronRightIcon,
  CircleAlertIcon,
  CircleCheckIcon,
  CircleDotIcon,
  CircleIcon,
  CircleSlashIcon,
  CopyIcon,
  FilePenIcon,
  FilePlusIcon,
  FileTextIcon,
  GlobeIcon,
  ListChecksIcon,
  MessageSquareIcon,
  PlugIcon,
  SearchIcon,
  SquareTerminalIcon,
  TelescopeIcon,
  WrenchIcon,
} from "lucide-react-native";
import Animated, { useReducedMotion } from "react-native-reanimated";
import { useCSSVariable } from "uniwind";
import {
  changeCount,
  diffLines,
  exploredPhrase,
  spanLabel,
  toolOutcome,
  toolPhrase,
  toolState,
  toolView,
} from "@zerolux/chat";
import type { ToolBlock, ToolOutcome, ToolView } from "@zerolux/chat";
import { Fold } from "@/components/fold";
import { MessageBody } from "@/components/message-body";
import { Text } from "@/components/ui/text";
import { cn } from "@/lib/utils";

type ChatTitle = (id: string) => string | undefined;
type State = ReturnType<typeof toolState>;

/** Past this many lines a long output shows its end, and all of it on request. */
const PREVIEW = 12;

/**
 * One tool call, as the web draws it: a line saying what it does or did, opened for what it
 * was given and what came back, drawn for its kind: a command, a file, a search, a ZeroLux
 * message, an MCP tool.
 */
export function ToolCall({
  tool,
  chatTitle,
}: {
  tool: ToolBlock;
  chatTitle?: ChatTitle;
}) {
  const view = useMemo(
    () => toolView(tool.name, tool.input),
    [tool.name, tool.input],
  );
  const outcome = useMemo(
    () => tool.result && toolOutcome(tool.result.output),
    [tool.result],
  );
  const state = toolState(tool, view, outcome);
  const line = summary(view, outcome, state === "running", chatTitle);
  const faint = String(useCSSVariable("--color-faint"));
  return (
    <Fold
      summary={(open) => (
        <View className="flex-row items-center gap-2 px-3 py-2">
          <View className="size-4 items-center justify-center">
            <StateIcon state={state} view={view} />
          </View>
          <Verb running={state === "running"}>
            {state === "denied" ? "Declined" : line.verb}
          </Verb>
          <View className="min-w-0 flex-1">{line.subject}</View>
          <View className="flex-row items-center gap-2 pl-1">
            {line.meta}
            <Elapsed tool={tool} />
            <View style={{ transform: [{ rotate: open ? "90deg" : "0deg" }] }}>
              <ChevronRightIcon color={faint} size={13} strokeWidth={2} />
            </View>
          </View>
        </View>
      )}
    >
      <View className="gap-2 border-t border-border px-3 py-2.5">
        <Body view={view} tool={tool} outcome={outcome} chatTitle={chatTitle} />
      </View>
    </Fold>
  );
}

/** Explorations one after another as one line ("Explored 3 files, 2 searches"), opened on each. */
export function ExploredCalls({
  tools,
  chatTitle,
}: {
  tools: ToolBlock[];
  chatTitle?: ChatTitle;
}) {
  const { verb, subject } = exploredPhrase(tools);
  const running = verb === "Exploring";
  const [agent, faint] = useCSSVariable(["--color-agent", "--color-faint"]).map(
    String,
  );
  return (
    <Fold
      summary={(open) => (
        <View className="flex-row items-center gap-2 px-3 py-2">
          <View className="size-4 items-center justify-center">
            {running ? (
              <ActivityIndicator
                size="small"
                color={agent}
                accessibilityLabel="Running"
                style={{ transform: [{ scale: 0.7 }] }}
              />
            ) : (
              <TelescopeIcon color={faint} size={14} strokeWidth={1.75} />
            )}
          </View>
          <Verb running={running}>{verb}</Verb>
          <Text
            numberOfLines={1}
            className="flex-1 text-[12.5px] text-muted-foreground"
          >
            {subject}
          </Text>
          <View style={{ transform: [{ rotate: open ? "90deg" : "0deg" }] }}>
            <ChevronRightIcon color={faint} size={13} strokeWidth={2} />
          </View>
        </View>
      )}
    >
      <View className="ml-5 border-t border-l border-border">
        {tools.map((tool, i) => (
          <View
            key={tool.key}
            className={cn(i > 0 && "border-t border-border")}
          >
            <ToolCall tool={tool} chatTitle={chatTitle} />
          </View>
        ))}
      </View>
    </Fold>
  );
}

function StateIcon({ state, view }: { state: State; view: ToolView }) {
  const [agent, destructive, attention, faint] = useCSSVariable([
    "--color-agent",
    "--color-destructive",
    "--color-attention",
    "--color-faint",
  ]).map(String);
  switch (state) {
    case "running":
      return (
        <ActivityIndicator
          size="small"
          color={agent}
          accessibilityLabel="Running"
          style={{ transform: [{ scale: 0.7 }] }}
        />
      );
    case "error":
      return (
        <CircleAlertIcon
          color={destructive}
          size={14}
          accessibilityLabel="Failed"
        />
      );
    case "denied":
      return (
        <BanIcon color={attention} size={14} accessibilityLabel="Declined" />
      );
    case "stopped":
      return (
        <CircleSlashIcon
          color={faint}
          size={14}
          accessibilityLabel="Stopped before it finished"
        />
      );
    case "done": {
      const Icon = kindIcons[view.kind];
      return <Icon color={faint} size={14} strokeWidth={1.75} />;
    }
  }
}

const kindIcons = {
  command: SquareTerminalIcon,
  read: FileTextIcon,
  edit: FilePenIcon,
  write: FilePlusIcon,
  patch: FilePenIcon,
  search: SearchIcon,
  web: GlobeIcon,
  agent: BotIcon,
  plan: ListChecksIcon,
  zerolux: MessageSquareIcon,
  mcp: PlugIcon,
  other: WrenchIcon,
};

// A light passes over the words: a second long every four, after a short wait, as on the web.
const sweep = {
  "0%": { opacity: 0.62 },
  "12%": { opacity: 1 },
  "25%": { opacity: 0.62 },
  "100%": { opacity: 0.62 },
};

/** The verb of the line; while the tool runs a light passes over it, dimmed when motion is reduced. */
function Verb({ running, children }: { running: boolean; children: string }) {
  const still = useReducedMotion();
  return (
    <Animated.View
      style={
        running
          ? still
            ? { opacity: 0.62 }
            : {
                animationName: sweep,
                animationDuration: "4s",
                animationDelay: "600ms",
                animationTimingFunction: "ease-in-out",
                animationIterationCount: "infinite",
              }
          : undefined
      }
    >
      <Text className="text-[13px] font-medium">{children}</Text>
    </Animated.View>
  );
}

/** A path as read at a glance: the file's name, its folder fainter. */
function PathLine({ path }: { path: string }) {
  const cut = path.lastIndexOf("/") + 1;
  return (
    <Text
      numberOfLines={1}
      ellipsizeMode="head"
      className="font-mono text-xs text-faint"
    >
      {path.slice(0, cut)}
      <Text className="font-mono text-xs text-foreground">
        {path.slice(cut)}
      </Text>
    </Text>
  );
}

/**
 * The line of a tool: the shared phrase (a verb in the tense of its state, what it worked on),
 * with paths drawn as paths and a measure on the right.
 */
function summary(
  view: ToolView,
  outcome: ToolOutcome | undefined,
  running: boolean,
  chatTitle?: ChatTitle,
): { verb: string; subject?: ReactNode; meta?: ReactNode } {
  const { verb, subject } = toolPhrase(view, running, chatTitle);
  const line = {
    verb,
    subject: subject ? (
      <Text
        numberOfLines={1}
        className="font-mono text-xs text-muted-foreground"
      >
        {subject}
      </Text>
    ) : undefined,
  };
  switch (view.kind) {
    case "command":
      return {
        ...line,
        meta: (
          <>
            {view.commands.length > 1 ? (
              <Meta>+{view.commands.length - 1}</Meta>
            ) : null}
            {outcome?.timedOut ? (
              <Meta className="text-destructive">timed out</Meta>
            ) : null}
            {outcome?.exit ? (
              <Meta className="text-destructive">exit {outcome.exit}</Meta>
            ) : null}
          </>
        ),
      };
    case "read":
      return {
        ...line,
        subject: <PathLine path={view.path} />,
        meta: view.lines ? <Meta>{view.lines}</Meta> : null,
      };
    case "edit":
      return {
        ...line,
        subject: <PathLine path={view.path} />,
        meta: <Counts {...changeCount(view.changes)} />,
      };
    case "write":
      return {
        ...line,
        subject: <PathLine path={view.path} />,
        meta: <Counts added={view.text ? view.text.split("\n").length : 0} />,
      };
    case "patch":
      return {
        ...line,
        subject: view.files[0] ? <PathLine path={view.files[0]} /> : undefined,
        meta:
          view.files.length > 1 ? <Meta>+{view.files.length - 1}</Meta> : null,
      };
    case "plan":
      return {
        ...line,
        meta: (
          <Meta>
            {view.steps.filter((s) => s.status === "done").length}/
            {view.steps.length}
          </Meta>
        ),
      };
    case "mcp":
      return {
        ...line,
        meta: (
          <View className="rounded-xs border border-border px-1">
            <Meta>{view.server}</Meta>
          </View>
        ),
      };
  }
  return line;
}

function Meta({
  className,
  children,
}: {
  className?: string;
  children: ReactNode;
}) {
  return (
    <Text className={cn("font-mono text-[11px] text-faint", className)}>
      {children}
    </Text>
  );
}

function Counts({ added, removed }: { added: number; removed?: number }) {
  return (
    <>
      <Meta className="text-success">+{added}</Meta>
      {removed !== undefined ? (
        <Meta className="text-destructive">−{removed}</Meta>
      ) : null}
    </>
  );
}

/** How long a tool took; while it runs, how long so far, counted live. */
function Elapsed({ tool }: { tool: ToolBlock }) {
  const running = !tool.result && !tool.stopped;
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [running]);
  const start = tool.time && Date.parse(tool.time);
  if (!running && !tool.result?.time) return null;
  const end = tool.result?.time ? Date.parse(tool.result.time) : now;
  // Live, the count shows once it is worth watching; done, any second counts.
  if (!start || Number.isNaN(end) || end - start < (running ? 10_000 : 1000))
    return null;
  return <Meta>{spanLabel(end - start)}</Meta>;
}

/** What a tool was given and gave back, drawn for its kind. */
function Body({
  view,
  tool,
  outcome,
  chatTitle,
}: {
  view: ToolView;
  tool: ToolBlock;
  outcome?: ToolOutcome;
  chatTitle?: ChatTitle;
}) {
  const router = useRouter();
  const failed =
    tool.result?.error || !!outcome?.exit || outcome?.timedOut || undefined;
  const plain = outcome ? <Output outcome={outcome} failed={failed} /> : null;
  // A refused call says why, whatever it is.
  if (outcome?.denied)
    return (
      <Text selectable className="text-[13px] text-attention">
        {outcome.text}
      </Text>
    );
  switch (view.kind) {
    case "command":
      return (
        <Panel
          copy={view.commands.join("\n") || view.script || ""}
          failed={failed}
        >
          {view.script && !view.commands.length ? (
            <Text
              selectable
              className="font-mono text-xs text-muted-foreground"
            >
              {view.script}
            </Text>
          ) : (
            <Text selectable className="font-mono text-xs">
              {view.commands.map((command, i) => (
                <Text key={i} className="font-mono text-xs">
                  {i ? "\n" : ""}
                  <Text className="font-mono text-xs text-faint">$ </Text>
                  {command}
                </Text>
              ))}
            </Text>
          )}
          {view.description ? (
            <Text className="font-mono text-xs text-faint">
              # {view.description}
            </Text>
          ) : null}
          {outcome?.text ? (
            <View className="mt-1 border-t border-border pt-2">
              <Long text={outcome.text} failed={failed} />
            </View>
          ) : null}
        </Panel>
      );
    case "edit":
      return (
        <>
          {view.changes.map((change, i) => (
            <Diff key={i} before={change.before} after={change.after} />
          ))}
          {failed ? plain : null}
        </>
      );
    case "write":
      return (
        <>
          <Panel copy={view.text}>
            <Long text={view.text} />
          </Panel>
          {failed ? plain : null}
        </>
      );
    case "patch":
      return (
        <Panel copy={view.patch}>
          <Long text={view.patch} patch />
        </Panel>
      );
    case "agent":
      return (
        <>
          {view.prompt ? (
            <Text selectable className="text-[13px] text-muted-foreground">
              {view.prompt}
            </Text>
          ) : null}
          {outcome?.text ? (
            <View className="border-t border-border pt-2">
              <MessageBody text={outcome.text} />
            </View>
          ) : null}
        </>
      );
    case "plan":
      return (
        <View className="gap-1">
          {view.steps.map((step, i) => (
            <Step key={i} text={step.text} status={step.status} />
          ))}
        </View>
      );
    case "zerolux":
      return (
        <>
          {view.text ? (
            <View className="rounded-md border-l-2 border-agent/40 bg-agent/5 px-3 py-2">
              <MessageBody text={view.text} />
            </View>
          ) : null}
          {view.chat && view.action !== "inbox" ? (
            <Pressable
              onPress={() => router.push(`/chat/${view.chat}`)}
              accessibilityRole="link"
              hitSlop={6}
              className="self-start"
            >
              <Text className="text-xs text-muted-foreground underline">
                Open {chatTitle?.(view.chat) ?? "the chat"}
              </Text>
            </Pressable>
          ) : null}
          {view.action === "inbox" || failed ? plain : null}
        </>
      );
    case "mcp":
    case "other":
      return (
        <>
          <Arguments args={view.args} />
          {plain}
        </>
      );
  }
  // Reads, searches and the web: what came back is the point.
  return plain;
}

/** Text in a panel with its copy button, like a terminal or a code block. */
function Panel({
  copy,
  failed,
  children,
}: {
  copy: string;
  failed?: boolean;
  children: ReactNode;
}) {
  return (
    <View
      className={cn(
        "flex-row items-start gap-2 rounded-md border border-border bg-muted/50 py-2 pl-3",
        failed && "border-destructive/40",
      )}
    >
      <View className="min-w-0 flex-1 gap-1">{children}</View>
      <Copy text={copy} />
    </View>
  );
}

/** One replacement in a file, line by line: kept lines faint, removed on red, added on green. */
function Diff({ before, after }: { before: string; after: string }) {
  const lines = useMemo(() => diffLines(before, after), [before, after]);
  return (
    <View className="overflow-hidden rounded-md border border-border py-1">
      {lines.map((line, i) => (
        <View
          key={i}
          className={cn(
            "flex-row",
            line.kind === "added" && "bg-success/10",
            line.kind === "removed" && "bg-destructive/10",
          )}
        >
          <Text
            className={cn(
              "w-5 text-center font-mono text-xs",
              line.kind === "added" && "text-success",
              line.kind === "removed" && "text-destructive",
            )}
          >
            {line.kind === "added" ? "+" : line.kind === "removed" ? "−" : ""}
          </Text>
          <Text
            selectable
            className={cn(
              "flex-1 pr-2 font-mono text-xs",
              line.kind === "same" ? "text-faint" : "text-foreground/90",
            )}
          >
            {line.text || " "}
          </Text>
        </View>
      ))}
    </View>
  );
}

/** A long text shows its last lines, with the rest one tap away; a patch colours its lines. */
function Long({
  text,
  patch,
  failed,
}: {
  text: string;
  patch?: boolean;
  failed?: boolean;
}) {
  const [all, setAll] = useState(false);
  const lines = text.split("\n");
  const hidden = all ? 0 : Math.max(0, lines.length - PREVIEW);
  const shown = hidden ? lines.slice(hidden) : lines;
  return (
    <View className="gap-1">
      {hidden ? (
        <Pressable
          onPress={() => {
            void Haptics.selectionAsync();
            setAll(true);
          }}
          accessibilityRole="button"
          hitSlop={4}
          className="self-start"
        >
          <Text className="font-mono text-[11px] text-agent-foreground">
            Show {hidden} earlier lines
          </Text>
        </Pressable>
      ) : null}
      <Text
        selectable
        className={cn(
          "font-mono text-xs text-muted-foreground",
          failed && "text-destructive",
        )}
      >
        {patch
          ? shown.map((row, i) => (
              <Text
                key={i}
                className={cn(
                  "font-mono text-xs",
                  row.startsWith("+") && "text-success",
                  row.startsWith("-") && "text-destructive",
                  row.startsWith("*** ") && "text-foreground",
                  row.startsWith("@@") && "text-faint",
                )}
              >
                {i ? "\n" : ""}
                {row || " "}
              </Text>
            ))
          : shown.join("\n")}
      </Text>
    </View>
  );
}

function Arguments({ args }: { args: unknown }) {
  if (args == null) return null;
  if (typeof args !== "object" || Array.isArray(args))
    return (
      <Panel copy={typeof args === "string" ? args : JSON.stringify(args)}>
        <Long
          text={typeof args === "string" ? args : JSON.stringify(args, null, 2)}
        />
      </Panel>
    );
  const entries = Object.entries(args);
  if (!entries.length) return null;
  return (
    <View className="gap-1">
      {entries.map(([key, value]) => (
        <View key={key} className="flex-row gap-3">
          <Text className="font-mono text-xs text-faint">{key}</Text>
          <Text
            selectable
            className="flex-1 font-mono text-xs text-muted-foreground"
          >
            {typeof value === "string" ? value : JSON.stringify(value, null, 2)}
          </Text>
        </View>
      ))}
    </View>
  );
}

/** What came back: its text, and its images, each opened in place at full size on a tap. */
function Output({
  outcome,
  failed,
}: {
  outcome: ToolOutcome;
  failed?: boolean;
}) {
  const [full, setFull] = useState<number>();
  return (
    <>
      {outcome.text ? (
        <Panel copy={outcome.text} failed={failed}>
          <Long text={outcome.text} failed={failed} />
        </Panel>
      ) : null}
      {outcome.images.length ? (
        <View className="flex-row flex-wrap gap-2">
          {outcome.images.map((src, i) => (
            <Pressable
              key={i}
              onPress={() => setFull(full === i ? undefined : i)}
              accessibilityRole="imagebutton"
              accessibilityLabel={full === i ? "Smaller" : "Larger"}
              className="overflow-hidden rounded-md border border-border"
              style={{ width: full === i ? "100%" : 160 }}
            >
              <Image
                source={{ uri: src }}
                resizeMode="contain"
                style={{ width: "100%", aspectRatio: 4 / 3 }}
              />
            </Pressable>
          ))}
        </View>
      ) : null}
    </>
  );
}

/** Copies its text, with a tap you can feel; for a moment it says so. */
function Copy({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const [faint, success] = useCSSVariable([
    "--color-faint",
    "--color-success",
  ]).map(String);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(timer);
  }, [copied]);
  return (
    <Pressable
      onPress={async () => {
        await Clipboard.setStringAsync(text);
        void Haptics.notificationAsync(
          Haptics.NotificationFeedbackType.Success,
        );
        setCopied(true);
      }}
      accessibilityRole="button"
      accessibilityLabel={copied ? "Copied" : "Copy"}
      hitSlop={8}
      className="size-6 items-center justify-center rounded-sm active:bg-accent"
      style={{ marginRight: 4 }}
    >
      {copied ? (
        <CheckIcon color={success} size={14} strokeWidth={2} />
      ) : (
        <CopyIcon color={faint} size={14} strokeWidth={1.75} />
      )}
    </Pressable>
  );
}

function Step({
  text,
  status,
}: {
  text: string;
  status: "pending" | "active" | "done";
}) {
  const [agent, faint, success] = useCSSVariable([
    "--color-agent",
    "--color-faint",
    "--color-success",
  ]).map(String);
  const Icon =
    status === "done"
      ? CircleCheckIcon
      : status === "active"
        ? CircleDotIcon
        : CircleIcon;
  return (
    <View className="flex-row items-start gap-2">
      <View className="mt-0.5">
        <Icon
          color={
            status === "done" ? success : status === "active" ? agent : faint
          }
          size={14}
          strokeWidth={1.75}
        />
      </View>
      <Text
        className={cn(
          "flex-1 text-[13px]",
          status === "done" && "text-faint line-through",
          status === "active" && "text-agent-foreground",
        )}
      >
        {text}
      </Text>
    </View>
  );
}
