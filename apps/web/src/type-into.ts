import { useEffect } from "react";
import type { RefObject } from "react";

/**
 * A composer that takes the keyboard. Opening it puts you in its box where a keyboard is at
 * hand; a touch screen keeps its keyboard down until you tap. Clicks keep doing what they do,
 * selecting text included; what you type or paste elsewhere on the page lands in the box, as
 * in Element and Mattermost: focus moves on keydown, before the character is written.
 */
export function useTypeInto(
  box: RefObject<HTMLTextAreaElement | null>,
  /** What is open, as the chat or the session: opening another focuses again. */
  opened: string,
  enabled = true,
) {
  useEffect(() => {
    if (!enabled || !matchMedia("(pointer: fine)").matches) return;
    box.current?.focus({ preventScroll: true });
    const keys = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing) return;
      const paste =
        (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "v";
      const typed =
        (event.key.length === 1 || event.key === "Dead") &&
        !event.metaKey &&
        !event.ctrlKey;
      if (!paste && !typed) return;
      // Another field, or a dialog, keeps its keys; Space presses the control it is on.
      const at = document.activeElement;
      if (
        at?.closest(
          "input, textarea, select, [contenteditable=true], [role=dialog]",
        ) ||
        (event.key === " " && at?.closest("button, a, [role=button]"))
      )
        return;
      box.current?.focus({ preventScroll: true });
    };
    document.addEventListener("keydown", keys);
    return () => document.removeEventListener("keydown", keys);
  }, [box, opened, enabled]);
}
