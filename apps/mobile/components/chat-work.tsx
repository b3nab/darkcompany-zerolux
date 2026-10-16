import { useMemo } from "react";
import { Pressable, View } from "react-native";
import { ChevronRightIcon } from "lucide-react-native";
import Animated, { useReducedMotion } from "react-native-reanimated";
import { useCSSVariable } from "uniwind";
import { currentStep, sessionBlocks, turnLine } from "@zerolux/chat";
import type { ChatSession, ChatTurn, SessionBlock } from "@zerolux/chat";
import { SessionBlocks } from "@/components/session-blocks";
import { useInterrupt } from "@/components/session";
import { Text } from "@/components/ui/text";

/** A turn's blocks as a chat shows them: its end is already in the line above them. */
const workBlocks = (turn: ChatTurn | undefined) =>
  sessionBlocks(turn?.events ?? []).filter((b) => b.kind !== "turn");

/** What an agent did, under the message that asked: one line, opened on the whole turn. */
export function WorkLine({
  name,
  turn,
  open,
  toggle,
}: {
  name: string;
  turn: ChatTurn;
  open: boolean;
  toggle: () => void;
}) {
  const faint = String(useCSSVariable("--color-faint"));
  const all = useMemo(() => sessionBlocks(turn.events), [turn]);
  return (
    <View className="mt-1 ml-[42px] min-w-0">
      <Pressable
        onPress={toggle}
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        hitSlop={4}
        className="-mx-1.5 flex-row items-center gap-1.5 self-start rounded-sm px-1.5 py-0.5 active:bg-accent"
      >
        <Chevron open={open} color={faint} />
        <Text
          numberOfLines={1}
          className="shrink font-mono text-[11.5px] text-faint"
        >
          <Text className="font-mono text-[11.5px] text-agent-foreground">
            {name}
          </Text>{" "}
          {turnLine(turn, all)}
        </Text>
      </Pressable>
      {open ? (
        <WorkBlocks blocks={all.filter((b) => b.kind !== "turn")} />
      ) : null}
    </View>
  );
}

/**
 * An agent at work on this chat: what it is doing now, opened on the turn so far, with
 * Interrupt for the owner.
 */
export function LiveWork({
  session,
  name,
  turn,
  open,
  toggle,
}: {
  session: ChatSession;
  name: string;
  /** Absent until its turn is read. */
  turn?: ChatTurn;
  open: boolean;
  toggle: () => void;
}) {
  const ion = String(useCSSVariable("--color-agent-foreground"));
  const stop = useInterrupt(session);
  const blocks = useMemo(() => workBlocks(turn), [turn]);
  const step = currentStep(blocks);
  return (
    <View className="min-w-0">
      <View className="max-w-full flex-row items-center self-start rounded-full border border-agent/30 bg-agent/10 py-0.5 pr-1 pl-1">
        <Pressable
          onPress={toggle}
          disabled={!turn}
          accessibilityRole="button"
          accessibilityLabel={
            turn ? (open ? "Hide the work" : "Show the work") : undefined
          }
          accessibilityState={{ expanded: open, disabled: !turn }}
          className="min-w-0 shrink flex-row items-center gap-2 rounded-full py-1 pr-1.5 pl-2 active:bg-agent/10"
        >
          <Dots />
          <Text
            numberOfLines={1}
            className="shrink font-mono text-[12px] text-agent-foreground"
          >
            {name}
            <Text className="font-mono text-[12px] text-agent-foreground/70">
              {step ? ` · ${step}` : " is working"}
            </Text>
          </Text>
          {turn ? <Chevron open={open} color={ion} /> : null}
        </Pressable>
        {stop.allowed ? (
          <Pressable
            onPress={() => void stop.interrupt()}
            disabled={stop.busy}
            accessibilityRole="button"
            accessibilityLabel={`Interrupt ${name}`}
            hitSlop={4}
            className={
              stop.busy
                ? "rounded-full px-2 py-1 opacity-50"
                : "rounded-full px-2 py-1 active:bg-agent/10"
            }
          >
            <Text className="font-mono text-[12px] text-agent-foreground">
              Interrupt
            </Text>
          </Pressable>
        ) : null}
      </View>
      {stop.error ? (
        <Text className="mt-1 text-xs text-destructive">{stop.error}</Text>
      ) : null}
      {open && blocks.length ? <WorkBlocks blocks={blocks} /> : null}
    </View>
  );
}

function WorkBlocks({ blocks }: { blocks: SessionBlock[] }) {
  return (
    <View className="mt-2 mb-1 ml-1.5 gap-3 border-l border-border pl-4">
      <SessionBlocks blocks={blocks} />
    </View>
  );
}

function Chevron({ open, color }: { open: boolean; color: string }) {
  return (
    <View style={{ transform: [{ rotate: open ? "90deg" : "0deg" }] }}>
      <ChevronRightIcon color={color} size={12} strokeWidth={2} />
    </View>
  );
}

const pulse = { from: { opacity: 1 }, to: { opacity: 0.3 } };

/** Three lights pulsing in turn while the agent works; still when motion is reduced. */
function Dots() {
  const still = useReducedMotion();
  const agent = String(useCSSVariable("--color-agent"));
  return (
    <View className="flex-row gap-1">
      {[0, 300, 600].map((delay) => (
        <Animated.View
          key={delay}
          style={[
            {
              width: 6,
              height: 6,
              borderRadius: 1.5,
              backgroundColor: agent,
            },
            still
              ? null
              : {
                  animationName: pulse,
                  animationDuration: "900ms",
                  animationDelay: `${delay}ms`,
                  animationDirection: "alternate",
                  animationIterationCount: "infinite",
                },
          ]}
        />
      ))}
    </View>
  );
}
