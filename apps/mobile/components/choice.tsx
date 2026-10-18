import { Pressable, View } from "react-native";
import { Text } from "@/components/ui/text";
import { cn } from "@/lib/utils";

/** One choice among a few; the optional empty choice clears an explicit setting. */
export function Choice<T extends string>({
  label,
  options,
  value,
  onChange,
  none,
  disabled = false,
}: {
  label: string;
  options: Partial<Record<T, string>>;
  value: T | "";
  onChange: (next: T | "") => void;
  none?: string;
  disabled?: boolean;
}) {
  const chip = (key: T | "", text: string) => (
    <Pressable
      key={key}
      onPress={() => onChange(key)}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityState={{ selected: value === key, disabled }}
      className={cn(
        "rounded-full border px-2.5 py-1",
        value === key ? "border-human bg-human/10" : "border-border",
        disabled && "opacity-50",
      )}
    >
      <Text className="text-xs">{text}</Text>
    </Pressable>
  );
  return (
    <View className="gap-2">
      <Text className="text-sm font-medium">{label}</Text>
      <View className="flex-row flex-wrap gap-1.5">
        {none ? chip("", none) : null}
        {(Object.keys(options) as T[]).map((key) => chip(key, options[key]!))}
      </View>
    </View>
  );
}
