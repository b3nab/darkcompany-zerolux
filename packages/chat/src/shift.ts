const HOUR = 3_600_000;

/** When a member was online, or an agent worked or waited for a person. */
export interface ShiftSegment {
  kind: "working" | "waiting" | "online";
  from: number;
  to: number;
}
export const shiftLabels: Record<ShiftSegment["kind"], string> = {
  working: "Working",
  waiting: "Waiting for a person",
  online: "Online",
};

/**
 * The last 16 hours, ending at the next even hour so the ticks fall on round times. `at`
 * places a time in it, from 0 to 1.
 */
export function shiftWindow(now = Date.now()) {
  const end = Math.ceil(now / (2 * HOUR)) * 2 * HOUR;
  const start = end - 16 * HOUR;
  return {
    start,
    end,
    now,
    /** One tick every two hours, from the start. */
    ticks: Array.from({ length: 8 }, (_, i) => start + i * 2 * HOUR),
    at: (time: number) =>
      Math.max(0, Math.min(1, (time - start) / (end - start))),
  };
}

// TODO: kernel: a history of each member's states (online, working, waiting for a person)
// with start and end times; the Shift view draws it.
export const shiftSegments = (_actorId: string): ShiftSegment[] => [];
