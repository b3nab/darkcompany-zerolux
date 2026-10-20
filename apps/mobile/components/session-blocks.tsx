import type { ReactNode } from "react";
import { Pressable, View } from "react-native";
import { ChevronRightIcon, CircleAlertIcon } from "lucide-react-native";
import Animated, { FadeInDown } from "react-native-reanimated";
import { useCSSVariable } from "uniwind";
import {
  blockRuns,
  isSubagent,
  thoughtLabel,
  toolItems,
  toolsPhrase,
  turnLabel,
  useArrivals,
} from "@zerolux/chat";
import type {
  Approval,
  ApprovalItem,
  BlockRun,
  LiveItem,
  SessionBlock,
  ToolsRun,
} from "@zerolux/chat";
import { Fold } from "@/components/fold";
import { Listen } from "@/components/listen";
import { MessageBody } from "@/components/message-body";
import type { InputBlock } from "@/components/session-fork";
import {
  ExploredCalls,
  SubagentCard,
  ToolCall,
  Verb,
} from "@/components/tool-call";
import { Text } from "@/components/ui/text";
import { cn } from "@/lib/utils";
import { useDensity } from "../src/density";

type ChatTitle = (id: string) => string | undefined;
type Item = SessionBlock | ApprovalItem;
/** A request of the session, drawn where it was made: open while pending, a receipt after. */
type RenderApproval = (approval: Approval) => ReactNode;
/** The owner's choices on one of their inputs, on a long press. */
type InputMenu = (block: InputBlock) => void;
/** The agent with a voice, and the session it writes in. */
type Voice = { actorId: string; sessionId: string };

/**
 * A session's work, block by block, the same in the Agent Console and in chats: tools run one
 * after another read as one list; work that arrives live slides in. How much shows follows the
 * density: compact keeps the outcome, detailed opens every step.
 */
export function SessionBlocks({
  blocks,
  chatTitle,
  renderApproval,
}: {
  blocks: Item[];
  chatTitle?: ChatTitle;
  renderApproval?: RenderApproval;
}) {
  const fresh = useArrivals(blocks);
  return blockRuns(blocks).map((run) => (
    <SessionRunView
      key={run.key}
      run={run}
      fresh={fresh}
      chatTitle={chatTitle}
      renderApproval={renderApproval}
    />
  ));
}

/** Slides in what just arrived; what was already there stays put. */
function Arrive({ fresh, children }: { fresh: boolean; children: ReactNode }) {
  return fresh ? (
    <Animated.View entering={FadeInDown.duration(300)}>
      {children}
    </Animated.View>
  ) : (
    children
  );
}

/**
 * One step of a session's work, as the web draws it: what the agent received and wrote open;
 * its reasoning, tools and compactions folded to a line that opens on a tap; a request where
 * it was made.
 */
export function SessionRunView({
  run,
  fresh,
  chatTitle,
  renderApproval,
  inputMenu,
  voice,
}: {
  run: BlockRun<Item>;
  /** The keys of the blocks that just arrived, from `useArrivals`. */
  fresh: ReadonlySet<string>;
  /** The title of the chat an input came from; inputs name it when given. */
  chatTitle?: ChatTitle;
  renderApproval?: RenderApproval;
  inputMenu?: InputMenu;
  /** When its agent has a voice: what the agent writes can be listened to. */
  voice?: Voice;
}) {
  const density = useDensity();
  if (density === "compact" && run.kind === "thinking") return null;
  return (
    <Arrive fresh={fresh.has(run.key)}>
      {run.kind === "tools" ? (
        <ToolRun run={run} fresh={fresh} chatTitle={chatTitle} />
      ) : run.kind === "approval" ? (
        renderApproval?.(run.approval)
      ) : (
        <Block
          block={run}
          chatTitle={chatTitle}
          inputMenu={inputMenu}
          voice={voice}
        />
      )}
    </Arrive>
  );
}

/** Tools run one after another: one card, or in compact density one line that opens on it. */
function ToolRun({
  run,
  fresh,
  chatTitle,
}: {
  run: ToolsRun;
  fresh: ReadonlySet<string>;
  chatTitle?: ChatTitle;
}) {
  const card = (
    <View className="overflow-hidden rounded-md border border-border bg-card">
      {toolItems(run.tools).map((item, i) => (
        <Arrive key={item.key} fresh={fresh.has(item.key)}>
          <View className={cn(i > 0 && "border-t border-border")}>
            {item.kind === "explored" ? (
              <ExploredCalls tools={item.tools} chatTitle={chatTitle} />
            ) : (
              <ToolCall tool={item} chatTitle={chatTitle} />
            )}
          </View>
        </Arrive>
      ))}
    </View>
  );
  if (useDensity() !== "compact") return card;
  return (
    <Fold
      summary={(open) => (
        <View className="flex-row items-center gap-2">
          <Chevron open={open} />
          <Text
            numberOfLines={1}
            className="flex-1 font-mono text-xs text-faint"
          >
            {toolsPhrase(run.tools)}
          </Text>
        </View>
      )}
    >
      <View className="mt-1.5">{card}</View>
    </Fold>
  );
}

function Block({
  block,
  chatTitle,
  inputMenu,
  voice,
}: {
  block: SessionBlock;
  chatTitle?: ChatTitle;
  inputMenu?: InputMenu;
  voice?: Voice;
}) {
  const destructive = String(useCSSVariable("--color-destructive"));
  switch (block.kind) {
    case "input":
      // With a menu, a long press opens it, and Copy is there; else the text is selectable.
      return (
        <Pressable
          disabled={!inputMenu}
          onLongPress={inputMenu && (() => inputMenu(block))}
          accessibilityHint={
            inputMenu ? "Long press to edit and resend, and more" : undefined
          }
          className="max-w-[86%] gap-1 self-end rounded-md rounded-br-xs border border-human/25 bg-human/10 px-3 py-2 active:opacity-70"
        >
          {block.chat && chatTitle ? (
            <Text className="font-mono text-[11px] text-faint">
              From {chatTitle(block.chat) ?? "a chat"}
            </Text>
          ) : null}
          <Text selectable={!inputMenu} className="text-[15px] leading-[21px]">
            {block.text.trim()}
          </Text>
        </Pressable>
      );
    case "text":
      return voice ? (
        <View className="gap-1.5">
          <MessageBody text={block.text} />
          <Listen
            id={`${voice.sessionId}:${block.key}`}
            actorId={voice.actorId}
            text={block.text}
          />
        </View>
      ) : (
        <MessageBody text={block.text} />
      );
    case "thinking":
      return (
        <Fold
          // Its first line says what the reasoning is about; opened, all of it.
          summary={(open) => (
            <View className="flex-row items-center gap-2">
              <Chevron open={open} />
              <Text className="font-mono text-xs text-faint">
                {thoughtLabel(block)}
              </Text>
              <Text
                numberOfLines={1}
                className={cn(
                  "flex-1 text-[12.5px] text-faint italic",
                  open && "opacity-0",
                )}
              >
                {block.text.trim().split("\n")[0]}
              </Text>
            </View>
          )}
        >
          <Text
            selectable
            className="mt-1.5 ml-1.5 border-l border-border pl-3.5 text-sm text-muted-foreground"
          >
            {block.text}
          </Text>
        </Fold>
      );
    case "tool":
      // A subagent stands alone as a card of its own; another lone tool, in its card.
      return isSubagent(block) ? (
        <SubagentCard tool={block} chatTitle={chatTitle} />
      ) : (
        <View className="overflow-hidden rounded-md border border-border bg-card">
          <ToolCall tool={block} chatTitle={chatTitle} />
        </View>
      );
    case "turn":
      return <Divider>{turnLabel(block)}</Divider>;
    case "error":
      return (
        <View className="flex-row items-start gap-2 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2">
          <View className="mt-0.5">
            <CircleAlertIcon color={destructive} size={14} />
          </View>
          <Text selectable className="flex-1 text-sm text-destructive">
            {block.message}
          </Text>
        </View>
      );
    case "compacted":
      return (
        <Fold
          summary={(open) => (
            <View className="flex-row items-center gap-2">
              <Chevron open={open} />
              <Text className="font-mono text-[11px] text-faint">
                Context compacted
              </Text>
            </View>
          )}
        >
          {block.summary ? (
            <Text
              selectable
              className="mt-1.5 ml-1.5 border-l border-border pl-3.5 text-sm text-muted-foreground"
            >
              {block.summary}
            </Text>
          ) : null}
        </Fold>
      );
  }
}

/** The last lines of a command's output, as a terminal shows them. */
const tail = (text: string, lines = 12) =>
  text.replace(/\n$/, "").split("\n").slice(-lines).join("\n");

/**
 * What the session is producing right now, at the end of its work, drawn as its block will
 * be once the record has it: the agent's words as they come, its reasoning, a command's
 * latest output.
 */
export function LiveItemView({ item }: { item: LiveItem }) {
  const density = useDensity();
  switch (item.kind) {
    case "text":
      return <MessageBody text={item.text} />;
    case "thinking":
      if (density === "compact") return null;
      return (
        <Fold
          summary={(open) => (
            <View className="flex-row items-center gap-2">
              <Chevron open={open} />
              <Verb running={!item.done}>Thinking</Verb>
              <Text
                numberOfLines={1}
                className={cn(
                  "flex-1 text-[12.5px] text-faint italic",
                  open && "opacity-0",
                )}
              >
                {tail(item.text.trim(), 1)}
              </Text>
            </View>
          )}
        >
          <Text
            selectable
            className="mt-1.5 ml-1.5 border-l border-border pl-3.5 text-sm text-muted-foreground"
          >
            {item.text}
          </Text>
        </Fold>
      );
    case "output":
      return (
        <View className="overflow-hidden rounded-md border border-border bg-card">
          <View className="border-b border-border px-3 py-1.5">
            <Verb running={!item.done}>Output</Verb>
          </View>
          <Text
            selectable
            className="px-3 py-2 font-mono text-xs leading-[18px] text-muted-foreground"
          >
            {tail(item.text)}
          </Text>
        </View>
      );
  }
}

function Chevron({ open }: { open: boolean }) {
  const faint = String(useCSSVariable("--color-faint"));
  return (
    <View style={{ transform: [{ rotate: open ? "90deg" : "0deg" }] }}>
      <ChevronRightIcon color={faint} size={12} strokeWidth={2} />
    </View>
  );
}

/** A centered note between two rules: where a turn ends. */
function Divider({ children }: { children: ReactNode }) {
  return (
    <View className="my-1 flex-row items-center gap-3">
      <View className="h-px flex-1 bg-border" />
      <Text className="font-mono text-[11px] text-faint">{children}</Text>
      <View className="h-px flex-1 bg-border" />
    </View>
  );
}
