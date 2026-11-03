import type { Approval, ChatSession, DiscoveredSession } from "./chat";
import { nestDelegates, sessionAttention, sessionOutputAt } from "./presence";
import type { Attention } from "./presence";
import type { Chat } from "./useChat";

/** What a Console row shows first: it works, it needs you, it failed, it has news, or it rests. */
export type RowState = "running" | "needs" | "failed" | "unseen" | "idle";
const states: Record<Attention, RowState> = {
  approval: "needs",
  input: "needs",
  working: "running",
  failed: "failed",
  unseen: "unseen",
  idle: "idle",
};
export const rowState = (attention: Attention) => states[attention];

/** The groups of the Console's Live view: pinned, needing you, running, then by day. */
export type ConsoleGroup =
  | "pinned"
  | "needs"
  | "running"
  | "today"
  | "yesterday"
  | "week"
  | "older";
export const consoleGroups: ConsoleGroup[] = [
  "pinned",
  "needs",
  "running",
  "today",
  "yesterday",
  "week",
  "older",
];
export const consoleGroupLabels: Record<ConsoleGroup, string> = {
  pinned: "Pinned",
  needs: "Needs you",
  running: "Running",
  today: "Today",
  yesterday: "Yesterday",
  week: "Last 7 days",
  older: "Older",
};

const dayStart = (time: number) => new Date(time).setHours(0, 0, 0, 0);
/** How many calendar days ago a time was: 0 today. */
const daysAgo = (time: number, now: number) =>
  Math.round((dayStart(now) - dayStart(time)) / 86_400_000);

/** The day a time falls in, as the Console groups it; one with no time is the oldest. */
export function dayGroup(
  time: number | undefined,
  now = Date.now(),
): Extract<ConsoleGroup, "today" | "yesterday" | "week" | "older"> {
  if (time === undefined) return "older";
  const days = daysAgo(time, now);
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  return days < 7 ? "week" : "older";
}

/**
 * A row's time, at its right: minutes or hours today, Yesterday, the weekday within a week,
 * the day and month before that, with the year when it is another year's.
 */
export function rowTime(time: number, now = Date.now()) {
  const days = daysAgo(time, now);
  if (days <= 0) {
    const minutes = Math.floor((now - time) / 60_000);
    if (minutes < 1) return "now";
    return minutes < 60 ? `${minutes}m` : `${Math.floor(minutes / 60)}h`;
  }
  if (days === 1) return "Yesterday";
  const date = new Date(time);
  if (days < 7) return date.toLocaleDateString(undefined, { weekday: "short" });
  return date.toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
    ...(date.getFullYear() !== new Date(now).getFullYear() && {
      year: "numeric",
    }),
  });
}

/** When a session was last active: the last step its record has, else when it began. */
export const activityAt = (
  session: ChatSession,
  chat?: Pick<Chat, "outputs">,
) =>
  (chat ? sessionOutputAt(chat, session) : session.output_at) ??
  session.created_at;

/** A row of the Console: a session of the workspace, or one of the project's own, not in it yet. */
export type ConsoleRow = { key: string; state: RowState; depth: number } & (
  | {
      kind: "session";
      session: ChatSession;
      attention: Attention;
      /** When it was last active: always a time. */
      at: number;
      group?: ConsoleGroup;
    }
  | {
      kind: "native";
      native: DiscoveredSession;
      session?: undefined;
      at: number | undefined;
      group?: ConsoleGroup;
    }
);

/**
 * A Console list, the latest active first and, at a tie, the latest begun, each delegated
 * session right under its coordinator. `live` puts them in groups: pinned, needing you,
 * running, then by the day of their last activity; a delegate stays in its coordinator's. The
 * project's own sessions, not in the workspace yet, come in by their own last activity.
 */
export function consoleRows({
  sessions,
  approvals,
  chat,
  natives = [],
  live = false,
  now = Date.now(),
}: {
  sessions: ChatSession[];
  approvals: Approval[];
  chat?: Pick<Chat, "outputs">;
  natives?: DiscoveredSession[];
  live?: boolean;
  now?: number;
}): ConsoleRow[] {
  const grouped = (row: ConsoleRow): ConsoleRow => {
    if (!live) return row;
    if (row.kind === "session") {
      if (row.session.pinned_at) return { ...row, group: "pinned" };
      if (row.state === "needs" || row.state === "running")
        return { ...row, group: row.state };
    }
    return { ...row, group: dayGroup(row.at, now) };
  };
  const rows = [
    ...sessions.map((session): ConsoleRow => {
      const attention = sessionAttention(session, approvals);
      return {
        kind: "session",
        key: session.id,
        session,
        attention,
        state: rowState(attention),
        at: activityAt(session, chat),
        depth: 0,
      };
    }),
    ...natives.map((native): ConsoleRow => ({
      kind: "native",
      key: `native:${native.id}`,
      native,
      state: "idle",
      at: native.last_activity_at ?? undefined,
      depth: 0,
    })),
  ].map(grouped);
  const begun = (row: ConsoleRow) =>
    row.kind === "session" ? row.session.created_at : (row.at ?? 0);
  rows.sort(
    (a, b) =>
      consoleGroups.indexOf(a.group ?? "older") -
        consoleGroups.indexOf(b.group ?? "older") ||
      (b.at ?? 0) - (a.at ?? 0) ||
      begun(b) - begun(a),
  );
  let coordinator: ConsoleGroup | undefined;
  return nestDelegates(rows).map((row) => {
    if (!row.depth) coordinator = row.group;
    return row.depth ? { ...row, group: coordinator } : row;
  });
}
