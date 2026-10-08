import { useSyncExternalStore } from "react";

/** Wide enough for panes side by side: Tailwind's `md`, `lg` and `xl`, as media queries. */
export const MD = "(min-width: 48rem)";
export const LG = "(min-width: 64rem)";
export const XL = "(min-width: 80rem)";

/**
 * Whether a media query matches, kept current as the window changes. Without a window (a
 * server render, a test) every query matches: the desktop layout, with all its panes.
 */
export function useMedia(query: string) {
  return useSyncExternalStore(
    (onChange) => {
      const list = matchMedia(query);
      list.addEventListener("change", onChange);
      return () => list.removeEventListener("change", onChange);
    },
    () => matchMedia(query).matches,
    () => true,
  );
}
