import { useSyncExternalStore } from "react";

export type Theme = "light" | "dark" | "system";
const KEY = "zerolux-theme";
const DARK = "(prefers-color-scheme: dark)";

function stored(): Theme {
  try {
    const value = localStorage.getItem(KEY);
    return value === "light" || value === "dark" ? value : "system";
  } catch {
    return "system";
  }
}

let current = stored();
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => void listeners.delete(listener);
};
const subscribeSystem = (listener: () => void) => {
  const query = matchMedia(DARK);
  query.addEventListener("change", listener);
  return () => query.removeEventListener("change", listener);
};

/** The chosen theme as a class on <html>; without one, the CSS follows the system. */
export function applyTheme(theme: Theme = current) {
  document.documentElement.classList.remove("light", "dark");
  if (theme !== "system") document.documentElement.classList.add(theme);
}

/** Sets your theme, kept in this browser: light, dark, or the system's. */
export function chooseTheme(theme: Theme) {
  try {
    if (theme === "system") localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, theme);
  } catch {
    // Without storage the choice lasts until the page reloads.
  }
  current = theme;
  applyTheme(theme);
  for (const listener of listeners) listener();
}

/** Your theme and the one in effect now. */
export function useTheme() {
  const theme = useSyncExternalStore(
    subscribe,
    () => current,
    () => "system" as Theme,
  );
  const systemDark = useSyncExternalStore(
    subscribeSystem,
    () => matchMedia(DARK).matches,
    () => true,
  );
  const resolved: "light" | "dark" =
    theme === "system" ? (systemDark ? "dark" : "light") : theme;
  return { theme, resolved, choose: chooseTheme } as const;
}
