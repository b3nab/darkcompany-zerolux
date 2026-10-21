import * as Haptics from "expo-haptics";
import { useState } from "react";
import { ActionSheetIOS, Modal, Platform, Pressable } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { MenuItem, MenuProps } from "@zerolux/ui";
import { Icon, IconButton } from "@/components/ui-icon";
import { Text } from "@/components/ui/text";
import { cn } from "@/lib/utils";

/** Android's sheet of actions, from the bottom: Android's own dialog holds only three. */
function ActionSheet({
  items,
  onClose,
}: {
  items: MenuItem[];
  onClose: () => void;
}) {
  const { bottom } = useSafeAreaInsets();
  return (
    <Modal transparent visible animationType="fade" onRequestClose={onClose}>
      <Pressable
        accessibilityLabel="Close"
        onPress={onClose}
        className="flex-1 justify-end bg-black/40"
      >
        <Pressable
          className="rounded-t-2xl bg-card pt-2"
          style={{ paddingBottom: bottom + 8 }}
        >
          {items.map((item) => (
            <Pressable
              key={item.title}
              accessibilityRole="button"
              accessibilityState={{ disabled: item.disabled }}
              disabled={item.disabled}
              onPress={() => {
                onClose();
                item.onPress();
              }}
              className={cn(
                "min-h-12 flex-row items-center gap-3 px-5 active:bg-accent",
                item.disabled && "opacity-40",
              )}
            >
              {item.icon ? (
                <Icon
                  name={item.icon}
                  tone={item.tone === "danger" ? "danger" : "default"}
                />
              ) : null}
              <Text
                className={cn(
                  "text-base",
                  item.tone === "danger" && "text-destructive",
                )}
              >
                {item.title}
              </Text>
            </Pressable>
          ))}
          <Pressable
            accessibilityRole="button"
            onPress={onClose}
            className="mt-1 min-h-12 justify-center border-t border-border px-5 active:bg-accent"
          >
            <Text className="text-base font-medium">Cancel</Text>
          </Pressable>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

/**
 * A sheet of actions to show: iOS's own action sheet, or a sheet of the app's on Android.
 * `sheet` goes in the tree for Android's.
 */
export function useActionSheet() {
  const [shown, setShown] = useState<MenuItem[]>();
  const show = (items: MenuItem[]) => {
    void Haptics.selectionAsync();
    if (Platform.OS !== "ios") return setShown(items);
    const marked = (is: (item: MenuItem) => boolean) =>
      items.flatMap((item, index) => (is(item) ? [index] : []));
    ActionSheetIOS.showActionSheetWithOptions(
      {
        options: [...items.map((item) => item.title), "Cancel"],
        cancelButtonIndex: items.length,
        destructiveButtonIndex: marked((item) => item.tone === "danger"),
        disabledButtonIndices: marked((item) => Boolean(item.disabled)),
      },
      (index) => items[index]?.onPress(),
    );
  };
  const sheet = shown ? (
    <ActionSheet items={shown} onClose={() => setShown(undefined)} />
  ) : null;
  return { show, sheet };
}

/** What can be done with something, behind one button. */
export function Menu({ label, icon = "ellipsis", items }: MenuProps) {
  const { show, sheet } = useActionSheet();
  return (
    <>
      <IconButton icon={icon} label={label} onPress={() => show(items)} />
      {sheet}
    </>
  );
}
