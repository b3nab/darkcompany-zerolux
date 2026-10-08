import * as SecureStore from "expo-secure-store";
import { useSyncExternalStore } from "react";
import { Appearance } from "react-native";
import { Uniwind, useUniwind } from "uniwind";
import { defaultTheme, knownTheme, variantOf } from "@zerolux/theme/themes";

/** Your light: daylight, night, or the system's. */
export type Light = "light" | "dark" | "system";
// The light keeps the key it had before there were themes, so nobody loses their choice.
const LIGHT = "theme";
const THEME = "theme-name";

let chosen = { theme: defaultTheme, light: "system" as Light };
// The named variants are registered in metro.config.js, from the same themes.json.
const setVariant = (theme: string, light: "light" | "dark") =>
  Uniwind.setTheme(
    variantOf(theme, light) as Parameters<typeof Uniwind.setTheme>[0],
  );
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => void listeners.delete(listener);
};

/**
 * Your theme and light, in Uniwind and in the native views. The default theme is Uniwind's own
 * light and dark, which follow the system by themselves; another theme is a named Uniwind theme,
 * which sets the native views back to the system's light, so a light of your own is set again.
 */
function apply() {
  if (chosen.theme === defaultTheme) return Uniwind.setTheme(chosen.light);
  let light = chosen.light;
  if (light === "system") {
    Uniwind.setTheme("system");
    light = Uniwind.currentTheme === "dark" ? "dark" : "light";
  }
  setVariant(chosen.theme, light);
  if (chosen.light !== "system") Appearance.setColorScheme(chosen.light);
}

// A named theme in the system's light changes with it.
Appearance.addChangeListener(({ colorScheme }) => {
  if (chosen.theme === defaultTheme || chosen.light !== "system") return;
  setVariant(chosen.theme, colorScheme === "dark" ? "dark" : "light");
});

function change(next: Partial<typeof chosen>) {
  chosen = { ...chosen, ...next };
  apply();
  for (const listener of listeners) listener();
}

/** The theme and light saved on this device; without them, the default in the system's light. */
export async function restoreTheme() {
  const [light, theme] = await Promise.all([
    SecureStore.getItemAsync(LIGHT),
    SecureStore.getItemAsync(THEME),
  ]);
  change({
    theme: knownTheme(theme),
    light: light === "light" || light === "dark" ? light : "system",
  });
}

/** Sets and keeps your light: light, dark, or the system's. */
export async function chooseLight(light: Light) {
  change({ light });
  if (light === "system") await SecureStore.deleteItemAsync(LIGHT);
  else await SecureStore.setItemAsync(LIGHT, light);
}

/** Sets and keeps your theme, one of themes.json. */
export async function chooseTheme(theme: string) {
  change({ theme: knownTheme(theme) });
  if (theme === defaultTheme) await SecureStore.deleteItemAsync(THEME);
  else await SecureStore.setItemAsync(THEME, theme);
}

/** Your theme and light, and the light in effect now. */
export function useTheme() {
  const { theme, light } = useSyncExternalStore(subscribe, () => chosen);
  const { theme: variant } = useUniwind();
  return {
    theme,
    light,
    resolved: (variant.endsWith("dark") ? "dark" : "light") as "light" | "dark",
  };
}
