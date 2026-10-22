import * as lucide from "lucide-react";
import { icons, PuzzleIcon } from "lucide-react";
import type { LucideIcon } from "lucide-react";

const named = lucide as unknown as Record<string, LucideIcon | undefined>;

/**
 * A Lucide icon by its name, as `kanban` or `file-text`, or a name Lucide renamed, as
 * `file-video`; one this app lacks shows as a puzzle.
 */
export function lucideIcon(name?: string): LucideIcon {
  const pascal = name
    ?.split("-")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join("");
  return (
    (pascal &&
      (icons[pascal as keyof typeof icons] ?? named[`${pascal}Icon`])) ||
    PuzzleIcon
  );
}
