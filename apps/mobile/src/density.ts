import { useState } from "react";
import { densityLabels } from "@zerolux/chat";
import type { Density } from "@zerolux/chat";
import { preference } from "./saved";

const density = preference<Density>(
  "density",
  "normal",
  (value): value is Density =>
    typeof value === "string" && value in densityLabels,
);

/** How much of a session's work is drawn, in the Console and in chats; this phone keeps it. */
export const useDensity = density.use;
export const setDensity = density.set;
export const restoreDensity = density.restore;

/** A step open as the density says, until you open or close it yourself. */
export function useOpen() {
  const [chosen, choose] = useState<boolean>();
  const detailed = useDensity() === "detailed";
  return [chosen ?? detailed, choose] as const;
}
