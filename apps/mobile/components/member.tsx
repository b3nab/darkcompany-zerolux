import { View } from "react-native";
import type { MemberTone } from "@zerolux/chat";
import { Text } from "@/components/ui/text";
import { cn } from "@/lib/utils";

type Kind = "human" | "agent";

const light: Record<MemberTone, string> = {
  on: "bg-human",
  working: "bg-agent",
  connecting: "bg-faint",
  connected: "bg-agent/60",
  attention: "bg-attention",
  stopped: "border border-faint",
};

/** The small light beside a member: round for people, square for agents, like their marks. */
export function Lamp({
  kind,
  tone,
  className,
}: {
  kind: Kind;
  tone: MemberTone;
  className?: string;
}) {
  return (
    <View
      className={cn(
        "size-2",
        kind === "human" ? "rounded-full" : "rounded-[1.5px]",
        light[tone],
        className,
      )}
    />
  );
}

const sizes = {
  sm: { box: "size-6", text: "text-[10px]", square: "rounded-sm" },
  md: { box: "size-8", text: "text-xs", square: "rounded-md" },
  lg: { box: "size-14", text: "text-lg", square: "rounded-xl" },
};

/**
 * A person is round, an agent is square: the shape says who acted, not only the name. With a
 * tone, the member's light sits in the corner.
 */
export function ActorMark({
  kind,
  name,
  tone,
  size = "md",
}: {
  kind: Kind;
  name: string;
  tone?: MemberTone;
  size?: keyof typeof sizes;
}) {
  const { box, text, square } = sizes[size];
  return (
    <View
      className={cn(
        "items-center justify-center border",
        box,
        kind === "human"
          ? "rounded-full border-human/35 bg-human/10"
          : cn(square, "border-agent/35 bg-agent/10"),
      )}
    >
      <Text
        className={cn(
          text,
          kind === "human"
            ? "font-semibold text-human-foreground"
            : "font-mono text-agent-foreground",
        )}
      >
        {kind === "human" ? name.slice(0, 1).toUpperCase() : name.slice(0, 2)}
      </Text>
      {tone && (
        <View className="absolute -right-1 -bottom-1 rounded-full bg-background p-0.5">
          <Lamp kind={kind} tone={tone} />
        </View>
      )}
    </View>
  );
}
