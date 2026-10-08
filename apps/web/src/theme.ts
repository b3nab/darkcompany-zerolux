import { useSyncExternalStore } from "react";
import { defaultTheme, knownTheme } from "@zerolux/theme/themes";

/** Your light: daylight, night, or the system's. */
export type Light = "light" | "dark" | "system";
// The light keeps the key it had before there were themes, so nobody loses their choice.
const LIGHT = "zerolux-theme";
const THEME = "zerolux-theme-name";
const DARK = "(prefers-color-scheme: dark)";

function read(key: string) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

/** Kept in this browser; without storage a choice lasts until the page reloads. */
function keep(key: string, value: string | null) {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    // Nothing to keep it in.
  }
}

const saved = read(LIGHT);
let chosen = {
  theme: knownTheme(read(THEME)),
  light: (saved === "light" || saved === "dark" ? saved : "system") as Light,
};
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

/**
 * Your theme and light on <html>: `data-theme` names any theme but the default, and the light
 * is always a class, the system's when that is your choice.
 */
function apply() {
  const root = document.documentElement;
  const light =
    chosen.light === "system"
      ? matchMedia(DARK).matches
        ? "dark"
        : "light"
      : chosen.light;
  root.classList.remove("light", "dark");
  root.classList.add(light);
  if (chosen.theme === defaultTheme) delete root.dataset.theme;
  else root.dataset.theme = chosen.theme;
}

/** Applies your theme now, and again whenever the system's light changes. */
export function startTheme() {
  apply();
  subscribeSystem(apply);
}

function change(next: Partial<typeof chosen>) {
  chosen = { ...chosen, ...next };
  apply();
  for (const listener of listeners) listener();
}

/** Sets your light: light, dark, or the system's. */
export function chooseLight(light: Light) {
  keep(LIGHT, light === "system" ? null : light);
  change({ light });
}

/** Sets your theme, one of themes.json. */
export function chooseTheme(theme: string) {
  keep(THEME, theme === defaultTheme ? null : theme);
  change({ theme: knownTheme(theme) });
}

/** Your theme and light, and the light in effect now. */
export function useTheme() {
  const { theme, light } = useSyncExternalStore(
    subscribe,
    () => chosen,
    () => chosen,
  );
  const systemDark = useSyncExternalStore(
    subscribeSystem,
    () => matchMedia(DARK).matches,
    () => true,
  );
  const resolved: "light" | "dark" =
    light === "system" ? (systemDark ? "dark" : "light") : light;
  return { theme, light, resolved, chooseTheme, chooseLight } as const;
}
