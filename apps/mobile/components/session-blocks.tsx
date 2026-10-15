import { useState } from "react";
import { ActivityIndicator, Pressable, View } from "react-native";
import { CircleAlertIcon, CircleCheckIcon } from "lucide-react-native";
import { useCSSVariable } from "uniwind";
import { toolLine, toolText } from "@zerolux/chat";
import type { SessionBlock } from "@zerolux/chat";
import { MessageBody } from "@/components/message-body";
import { Text } from "@/components/ui/text";
import { cn } from "@/lib/utils";

/**
 * One block of a session's work, as the web draws it: what the agent received and wrote
 * open; its reasoning, tools and compactions folded to one line that opens on a tap.
 */
export function SessionBlockView({
  block,
  chatTitle,
}: {
  block: SessionBlock;
  chatTitle: (id: string) => string | undefined;
}) {
  switch (block.kind) {
    case "input":
      return (
        <View className="max-w-[86%] gap-1 self-end rounded-md rounded-br-xs border border-human/25 bg-human/10 px-3 py-2">
          {block.chat ? (
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
          summary={
            <Text className="font-mono text-xs text-faint">Thinking</Text>
          }
        >
          <Text
            selectable
            className="mt-1 border-l border-border pl-3 text-sm text-muted-foreground"
          >
            {block.text}
          </Text>
        </Fold>
      );
    case "tool":
      return <Tool block={block} />;
    case "turn":
      return <Divider>Turn {block.status}</Divider>;
    case "error":
      return (
        <Text selectable className="text-sm text-destructive">
          {block.message}
        </Text>
      );
    case "compacted":
      return block.summary ? (
        <Fold summary={<Divider>Context compacted</Divider>}>
          <Text selectable className="mt-1 text-sm text-muted-foreground">
            {block.summary}
          </Text>
        </Fold>
      ) : (
        <Divider>Context compacted</Divider>
      );
  }
}

/** A tool call: its state, name and what it was given; opened, the input and its result. */
function Tool({ block }: { block: Extract<SessionBlock, { kind: "tool" }> }) {
  const [agent, destructive, faint] = useCSSVariable([
    "--color-agent",
    "--color-destructive",
    "--color-faint",
  ]).map(String);
  const state = !block.result
    ? "running"
    : block.result.error
      ? "error"
      : "done";
  return (
    <View className="rounded-md border border-border bg-card">
      <Fold
        summary={
          <View className="flex-row items-center gap-2 px-3 py-2">
            {state === "running" ? (
              <ActivityIndicator
                size="small"
                color={agent}
                accessibilityLabel="Running"
              />
            ) : state === "error" ? (
              <CircleAlertIcon
                color={destructive}
                size={14}
                accessibilityLabel="Failed"
              />
            ) : (
              <CircleCheckIcon
                color={faint}
                size={14}
                accessibilityLabel="Done"
              />
            )}
            <Text className="font-mono text-[12.5px] font-medium">
              {block.name}
            </Text>
            <Text
              numberOfLines={1}
              className="flex-1 font-mono text-xs text-muted-foreground"
            >
              {toolLine(block.input)}
            </Text>
          </View>
        }
      >
        <View className="gap-2 border-t border-border px-3 py-2">
          <Text selectable className="font-mono text-xs text-muted-foreground">
            {toolText(block.input)}
          </Text>
          {block.result ? (
            <Text
              selectable
              className={cn(
                "border-t border-border pt-2 font-mono text-xs",
                block.result.error && "text-destructive",
              )}
            >
              {toolText(block.result.output)}
            </Text>
          ) : null}
        </View>
      </Fold>
    </View>
  );
}

/** A line that opens what it folds on a tap, like the web's details. */
function Fold({
  summary,
  children,
}: {
  summary: React.ReactNode;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <View>
      <Pressable
        onPress={() => setOpen(!open)}
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        hitSlop={4}
      >
        {summary}
      </Pressable>
      {open ? children : null}
    </View>
  );
}

/** A centered note between two rules: where a turn ends or the context was compacted. */
function Divider({ children }: { children: React.ReactNode }) {
  return (
    <View className="my-1 flex-row items-center gap-3">
      <View className="h-px flex-1 bg-border" />
      <Text className="font-mono text-[11px] text-faint">{children}</Text>
      <View className="h-px flex-1 bg-border" />
    </View>
  );
}
