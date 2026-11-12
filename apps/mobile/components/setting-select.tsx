import { useState } from "react";
import { Modal, Pressable, View } from "react-native";
import { LegendList } from "@legendapp/list/react-native";
import { Button } from "@/components/ui/button";
import { Text } from "@/components/ui/text";
import { cn } from "@/lib/utils";
import { settingChoices } from "@zerolux/chat";
import { Input } from "@/components/ui/input";

/**
 * Native choices, virtualized for a harness catalog, with model IDs where supported. Compact,
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
  custom = false,
  onOpen,
}: {
  label: string;
  value: string;
  options: Record<string, string>;
  onChange(value: string): void;
  disabled?: boolean;
  none?: string;
  placeholder?: string;
  compact?: boolean;
  custom?: boolean;
  onOpen?(): void;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const choices = [
    ...(none && !search ? [{ value: "", label: none }] : []),
    ...settingChoices(options, search, custom),
  ];
  const selected =
    options[value] ?? (!value ? none : undefined) ?? (value || placeholder);
  const choose = (next: string) => {
    if (disabled) return;
    onChange(next);
    setOpen(false);
  };
  return (
    <View className={compact ? "max-w-[48%]" : "gap-2"}>
      {compact ? null : <Text className="text-sm font-medium">{label}</Text>}
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={label}
        accessibilityValue={{ text: selected }}
        accessibilityState={{ disabled, expanded: open }}
        disabled={disabled}
        onPress={() => {
          setSearch("");
          onOpen?.();
          setOpen(true);
        }}
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
            {custom ? (
              <Input
                value={search}
                onChangeText={setSearch}
                placeholder="Search or enter a model ID"
                accessibilityLabel={label}
                autoCapitalize="none"
                autoCorrect={false}
                returnKeyType="done"
                onSubmitEditing={() => {
                  if (!disabled && search.trim() && choices[0])
                    choose(choices[0].value);
                }}
              />
            ) : null}
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
                  onPress={() => choose(item.value)}
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
