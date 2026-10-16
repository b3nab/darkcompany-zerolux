import type { ReactNode } from "react";
import { View } from "react-native";
import { ChevronRightIcon, CircleAlertIcon } from "lucide-react-native";
import Animated, { FadeInDown } from "react-native-reanimated";
import { useCSSVariable } from "uniwind";
import {
  blockRuns,
  thoughtLabel,
  toolItems,
  turnLabel,
  useArrivals,
} from "@zerolux/chat";
import type { BlockRun, SessionBlock } from "@zerolux/chat";
import { Fold } from "@/components/fold";
import { MessageBody } from "@/components/message-body";
import { ExploredCalls, ToolCall } from "@/components/tool-call";
import { Text } from "@/components/ui/text";
import { cn } from "@/lib/utils";

type ChatTitle = (id: string) => string | undefined;

/**
 * A session's work, block by block, the same in the Agent Console and in chats: tools run one
 * after another read as one list; work that arrives live slides in.
 */
export function SessionBlocks({
  blocks,
  chatTitle,
}: {
  blocks: SessionBlock[];
  chatTitle?: ChatTitle;
}) {
  const fresh = useArrivals(blocks);
  return blockRuns(blocks).map((run) => (
    <SessionRunView
      key={run.key}
      run={run}
      fresh={fresh}
      chatTitle={chatTitle}
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
 * its reasoning, tools and compactions folded to a line that opens on a tap.
 */
export function SessionRunView({
  run,
  fresh,
  chatTitle,
}: {
  run: BlockRun;
  /** The keys of the blocks that just arrived, from `useArrivals`. */
  fresh: ReadonlySet<string>;
  /** The title of the chat an input came from; inputs name it when given. */
  chatTitle?: ChatTitle;
}) {
  if (run.kind === "tools")
    return (
      <Arrive fresh={fresh.has(run.key)}>
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
      </Arrive>
    );
  return (
    <Arrive fresh={fresh.has(run.key)}>
      <Block block={run} chatTitle={chatTitle} />
    </Arrive>
  );
}

function Block({
  block,
  chatTitle,
}: {
  block: SessionBlock;
  chatTitle?: ChatTitle;
}) {
  const destructive = String(useCSSVariable("--color-destructive"));
  switch (block.kind) {
    case "input":
      return (
        <View className="max-w-[86%] gap-1 self-end rounded-md rounded-br-xs border border-human/25 bg-human/10 px-3 py-2">
          {block.chat && chatTitle ? (
            <Text className="font-mono text-[11px] text-faint">
              From {chatTitle(block.chat) ?? "a chat"}
            </Text>
          ) : null}
          <Text selectable className="text-[15px] leading-[21px]">
            {block.text}
          </Text>
        </View>
      );
    case "text":
      return <MessageBody text={block.text} />;
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
      return (
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
