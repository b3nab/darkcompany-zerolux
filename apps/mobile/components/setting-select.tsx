import { useState } from "react";
import { Modal, Pressable, View } from "react-native";
import { LegendList } from "@legendapp/list/react-native";
import { Button } from "@/components/ui/button";
import { Text } from "@/components/ui/text";
import { cn } from "@/lib/utils";

/**
 * Native choices, virtualized for a harness catalog; never a free-form model input. Compact,
 * it is a pill named by its value, as under a session's box.
 */
export function SettingSelect({
  label,
  value,
  options,
  onChange,
  disabled = false,
  none,
  placeholder = "The harness's own default",
  compact = false,
}: {
  label: string;
  value: string;
  options: Record<string, string>;
  onChange(value: string): void;
  disabled?: boolean;
  none?: string;
  placeholder?: string;
  compact?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const choices = [
    ...(none ? [{ value: "", label: none }] : []),
    ...Object.entries(options).map(([value, label]) => ({ value, label })),
  ];
  const selected =
    choices.find((choice) => choice.value === value)?.label ??
    (value || placeholder);
  return (
    <View className={compact ? "max-w-[48%]" : "gap-2"}>
      {compact ? null : <Text className="text-sm font-medium">{label}</Text>}
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={label}
        accessibilityValue={{ text: selected }}
        accessibilityState={{ disabled, expanded: open }}
        disabled={disabled}
        onPress={() => setOpen(true)}
        className={cn(
          compact
            ? "rounded-full border border-border px-2.5 py-1 active:bg-accent"
            : "min-h-11 rounded-md border border-input bg-background px-3 py-2",
          disabled && "opacity-50",
        )}
      >
        <Text
          numberOfLines={compact ? 1 : 2}
          className={compact ? "text-xs text-muted-foreground" : "text-sm"}
        >
          {selected}
        </Text>
      </Pressable>
      <Modal
        visible={open}
        transparent
        animationType="fade"
        onRequestClose={() => setOpen(false)}
      >
        <View className="flex-1 items-center justify-center bg-background/90 px-5">
          <View
            accessibilityViewIsModal
            className="h-3/4 w-full gap-3 rounded-lg border border-border bg-card p-4"
          >
            <Text accessibilityRole="header" className="text-lg font-medium">
              {label}
            </Text>
            <LegendList
              style={{ flex: 1 }}
              data={choices}
              keyExtractor={(choice) => choice.value}
              estimatedItemSize={48}
              renderItem={({ item }) => (
                <Pressable
                  accessibilityRole="button"
                  accessibilityState={{
                    selected: value === item.value,
                    disabled,
                  }}
                  disabled={disabled}
                  onPress={() => {
                    onChange(item.value);
                    setOpen(false);
                  }}
                  className={cn(
                    "min-h-11 rounded-md px-3 py-3",
                    value === item.value && "bg-accent",
                  )}
                >
                  <Text className="text-sm">{item.label}</Text>
                </Pressable>
              )}
            />
            <Button variant="outline" onPress={() => setOpen(false)}>
              <Text>Cancel</Text>
            </Button>
          </View>
        </View>
      </Modal>
    </View>
  );
}
