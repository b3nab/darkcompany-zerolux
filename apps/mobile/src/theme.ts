import * as SecureStore from "expo-secure-store";
import { Uniwind, useUniwind } from "uniwind";

export type Theme = "light" | "dark" | "system";
const KEY = "theme";

/** The theme saved on this device; without one the app follows the system. */
export async function restoreTheme() {
  const saved = await SecureStore.getItemAsync(KEY);
  Uniwind.setTheme(saved === "light" || saved === "dark" ? saved : "system");
}

/** Sets and keeps your theme: light, dark, or the system's. */
export async function chooseTheme(theme: Theme) {
  Uniwind.setTheme(theme);
  if (theme === "system") await SecureStore.deleteItemAsync(KEY);
  else await SecureStore.setItemAsync(KEY, theme);
}

/** Your choice, and the theme in effect now. */
export function useTheme() {
  const { theme, hasAdaptiveThemes } = useUniwind();
  return {
    chosen: (hasAdaptiveThemes ? "system" : theme) as Theme,
    resolved: theme as "light" | "dark",
  };
}
