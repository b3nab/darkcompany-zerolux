import { Pressable, View } from "react-native";
import * as Haptics from "expo-haptics";
import { Text } from "@/components/ui/text";
import { cn } from "@/lib/utils";

/** One of a few choices side by side, as iOS's segmented control, with a tick you can feel. */
export function Segmented<T extends string>({
  options,
  value,
  choose,
}: {
  options: [T, string][];
  value: T;
  choose: (value: T) => void;
}) {
  return (
    <View className="flex-row rounded-lg border border-border bg-card p-0.5">
      {options.map(([id, label]) => (
        <Pressable
          key={id}
          onPress={() => {
            if (id === value) return;
            void Haptics.selectionAsync();
            choose(id);
          }}
          accessibilityRole="button"
          accessibilityState={{ selected: value === id }}
          className={cn(
            "h-8 flex-1 items-center justify-center rounded-md",
            value === id && "bg-accent",
          )}
        >
          <Text
            className={cn(
              "text-xs font-medium",
              value === id ? "text-foreground" : "text-muted-foreground",
            )}
          >
            {label}
          </Text>
        </Pressable>
      ))}
    </View>
  );
}
