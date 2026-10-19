import { SquareIcon, Volume2Icon } from "lucide-react-native";
import { Pressable } from "react-native";
import { useCSSVariable } from "uniwind";
import { cn } from "@/lib/utils";
import { readText, usePlaying } from "../src/voice";

/** Reads an agent's text aloud with its voice; tapped again while it reads, it stops. */
export function Listen({
  id,
  actorId,
  text,
  className,
}: {
  id: string;
  actorId: string;
  text: string;
  className?: string;
}) {
  const on = usePlaying() === id;
  const color = String(
    useCSSVariable(on ? "--color-agent-foreground" : "--color-faint"),
  );
  const Icon = on ? SquareIcon : Volume2Icon;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={on ? "Stop reading aloud" : "Listen"}
      onPress={() => void readText(id, actorId, text)}
      hitSlop={10}
      className={cn("active:opacity-60", className)}
    >
      <Icon color={color} size={14} strokeWidth={1.75} />
    </Pressable>
  );
}
