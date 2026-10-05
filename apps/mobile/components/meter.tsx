import { View } from "react-native";
import { Text } from "@/components/ui/text";
import { cn } from "@/lib/utils";

const fill = {
  human: "bg-human",
  agent: "bg-agent",
  success: "bg-success",
};

/** The small uppercase label above a section. */
export function Eyebrow({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <Text
      className={cn(
        "font-mono text-[11px] font-medium tracking-wider text-faint uppercase",
        className,
      )}
    >
      {children}
    </Text>
  );
}

/** A labelled bar: how much of something is used or done. */
export function Meter({
  value,
  max,
  label,
  valueLabel,
  tone = "agent",
}: {
  value: number;
  max: number;
  label: string;
  valueLabel: string;
  tone?: keyof typeof fill;
}) {
  const ratio = max > 0 ? Math.min(1, value / max) : 0;
  return (
    <View
      role="meter"
      aria-valuemin={0}
      aria-valuemax={max}
      aria-valuenow={value}
      className="gap-1.5"
    >
      <View className="flex-row items-baseline justify-between gap-3">
        <Text
          numberOfLines={1}
          className="flex-1 text-xs text-muted-foreground"
        >
          {label}
        </Text>
        <Text className="font-mono text-xs text-muted-foreground">
          {valueLabel}
        </Text>
      </View>
      <View className="h-1 overflow-hidden rounded-full bg-muted">
        <View
          className={cn("h-full rounded-full", fill[tone])}
          style={{ width: `${ratio * 100}%` }}
        />
      </View>
    </View>
  );
}
