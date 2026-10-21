import * as Lucide from "lucide-react-native";
import { PuzzleIcon } from "lucide-react-native";
import type { LucideIcon } from "lucide-react-native";
import { Pressable } from "react-native";
import { useCSSVariable } from "uniwind";
import type { IconButtonProps, IconProps, Tone } from "@zerolux/ui";
import { cn } from "@/lib/utils";

/** A Lucide icon by its name, as `kanban` or `file-text`; a puzzle when the app has none. */
export function lucideIcon(name?: string): LucideIcon {
  if (!name) return PuzzleIcon;
  const named = name
    .split(/[-_\s]/)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join("");
  const icon = (Lucide as unknown as Record<string, unknown>)[`${named}Icon`];
  return typeof icon === "object" || typeof icon === "function"
    ? (icon as LucideIcon)
    : PuzzleIcon;
}

const toneColor: Record<Tone, string> = {
  default: "--color-foreground",
  muted: "--color-muted-foreground",
  success: "--color-success",
  warning: "--color-warning",
  danger: "--color-destructive",
};

/** An extension's icon, by its Lucide name, in a tone of the app's. */
export function Icon({ name, size = 20, tone = "muted" }: IconProps) {
  const color = String(useCSSVariable(toneColor[tone]));
  const Drawn = lucideIcon(name);
  return <Drawn color={color} size={size} strokeWidth={1.5} />;
}

/** An icon that does something, said by its label to those who hear the screen. */
export function IconButton({
  icon,
  label,
  onPress,
  disabled,
}: IconButtonProps) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      hitSlop={4}
      className={cn(
        "size-10 items-center justify-center rounded-lg active:bg-accent",
        disabled && "opacity-40",
      )}
    >
      <Icon name={icon} />
    </Pressable>
  );
}
