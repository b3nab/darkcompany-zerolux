import type { LucideIcon } from "lucide-react-native";
import type { ReactNode } from "react";
import { Pressable, View } from "react-native";
import { useCSSVariable } from "uniwind";
import { Eyebrow } from "@/components/meter";
import { Text } from "@/components/ui/text";

/** A titled group of settings in a card, as on More, My settings and Administration. */
export function Section({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <View className="gap-2">
      <Eyebrow>{title}</Eyebrow>
      <View className="overflow-hidden rounded-md border border-border bg-card">
        {children}
      </View>
    </View>
  );
}

/** One line of a section: an icon, a label and what sits on its right. */
export function Row({
  icon: Icon,
  label,
  onPress,
  trailing,
}: {
  icon: LucideIcon;
  label: string;
  onPress: () => void;
  trailing?: ReactNode;
}) {
  const muted = String(useCSSVariable("--color-muted-foreground"));
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      className="flex-row items-center gap-3 px-4 py-3 active:bg-accent"
    >
      <Icon color={muted} size={18} strokeWidth={1.5} />
      <Text className="flex-1 text-base">{label}</Text>
      {trailing}
    </Pressable>
  );
}

/** A setting the kernel does not offer yet, said plainly where it will be. */
export function Unavailable({ children }: { children: ReactNode }) {
  return (
    <Text className="px-4 py-3 text-sm text-muted-foreground">{children}</Text>
  );
}
