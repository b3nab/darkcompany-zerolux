import { Platform } from "react-native";
import { NativeTabs } from "expo-router/native-tabs";
import { useCSSVariable } from "uniwind";

/** A count on a tab, as the system draws it; nothing when there is nothing. */
export const badge = (count: number) =>
  count > 0 ? (
    <NativeTabs.Trigger.Badge>{String(count)}</NativeTabs.Trigger.Badge>
  ) : null;

/**
 * How the system's tab bars look in the theme. Android draws Material Symbols white and only
 * the selected label: the theme colors them, and every label shows, as on iOS. iOS keeps the
 * system's own look.
 */
export function useTabBarLook() {
  const [tint, muted, bar, indicator] = useCSSVariable([
    "--color-human-foreground",
    "--color-muted-foreground",
    "--color-card",
    "--color-accent",
  ]).map(String);
  return {
    tintColor: tint,
    ...(Platform.OS === "android"
      ? {
          iconColor: { default: muted, selected: tint },
          labelStyle: { default: { color: muted }, selected: { color: tint } },
          labelVisibilityMode: "labeled" as const,
          backgroundColor: bar,
          indicatorColor: indicator,
        }
      : {}),
  };
}
