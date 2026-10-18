import { useCallback, useEffect, useState } from "react";
import { errorMessage, kernelUrl, request } from "./client";

/**
 * Words the owner has a session receive when a cron pattern's time comes, in the time of the
 * computer running the kernel; queued after the turn in progress.
 */
export interface Schedule {
  id: string;
  session_id: string;
  cron: string;
  prompt: string;
  enabled: boolean;
  /** Null while it is off. */
  next_run_at: number | null;
  last_run_at: number | null;
  /** Why the last run did not reach the session, as when it was not running. */
  last_error: string | null;
  created_at: number;
}

export interface ScheduleChange {
  cron?: string;
  prompt?: string;
  enabled?: boolean;
}

/**
 * When a schedule runs, as people choose it: every hour at a minute, every day or weekday at
 * a time, every week on a day (0 Sunday to 6 Saturday), or a cron pattern of one's own.
 */
export type ScheduleRule =
  | { every: "hour"; minute: number }
  | { every: "day" | "weekday"; hour: number; minute: number }
  | { every: "week"; day: number; hour: number; minute: number }
  | { every: "custom"; cron: string };

export const scheduleEvery: Record<ScheduleRule["every"], string> = {
  hour: "Every hour",
  day: "Every day",
  weekday: "Every weekday",
  week: "Every week",
  custom: "Custom",
};

export const weekdays = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];

/** The cron pattern a rule says. */
export function cronOf(rule: ScheduleRule) {
  switch (rule.every) {
    case "hour":
      return `${rule.minute} * * * *`;
    case "day":
      return `${rule.minute} ${rule.hour} * * *`;
    case "weekday":
      return `${rule.minute} ${rule.hour} * * 1-5`;
    case "week":
      return `${rule.minute} ${rule.hour} * * ${rule.day}`;
    case "custom":
      return rule.cron.trim();
  }
}

const number = (field: string, max: number) =>
  /^\d{1,2}$/.test(field) && Number(field) <= max ? Number(field) : undefined;

/** The rule a cron pattern is, where it is one of the common ones; else a custom one. */
export function ruleOf(cron: string): ScheduleRule {
  const [minute, hour, date, month, day, ...rest] = cron.trim().split(/\s+/);
  const m = number(minute ?? "", 59);
  const h = number(hour ?? "", 23);
  if (m !== undefined && date === "*" && month === "*" && !rest.length) {
    if (hour === "*" && day === "*") return { every: "hour", minute: m };
    if (h !== undefined) {
      if (day === "*") return { every: "day", hour: h, minute: m };
      if (day === "1-5") return { every: "weekday", hour: h, minute: m };
      const d = number(day ?? "", 7);
      // Cron names Sunday 0 or 7.
      if (d !== undefined)
        return { every: "week", day: d % 7, hour: h, minute: m };
    }
  }
  return { every: "custom", cron: cron.trim() };
}

const time = (hour: number, minute: number) =>
  `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;

/** When a schedule runs, in words: "Every weekday at 09:00"; a custom pattern as it is. */
export function scheduleWords(cron: string) {
  const rule = ruleOf(cron);
  switch (rule.every) {
    case "hour":
      return rule.minute
        ? `Every hour at :${String(rule.minute).padStart(2, "0")}`
        : "Every hour";
    case "day":
    case "weekday":
      return `${scheduleEvery[rule.every]} at ${time(rule.hour, rule.minute)}`;
    case "week":
      return `Every ${weekdays[rule.day]} at ${time(rule.hour, rule.minute)}`;
    case "custom":
      return rule.cron;
  }
}

const sessionPath = (sessionId: string) =>
  `/sessions/${encodeURIComponent(sessionId)}/schedules`;
const path = (id: string) => `/schedules/${encodeURIComponent(id)}`;

/** Every session's schedules. */
export const allSchedules = (kernel = kernelUrl()) =>
  request<{ schedules: Schedule[] }>(kernel, "/schedules").then(
    ({ schedules }) => schedules,
  );

/** setTimeout's longest wait. */
const LONGEST = 2 ** 31 - 1;

/**
 * A session's schedules, and the owner's changes to them, each answered with the list as it
 * is then. They are read again when the next one's time has come, to show how it went.
 * Nothing is read without a session.
 */
export function useSessionSchedules(
  sessionId: string | undefined,
  kernel = kernelUrl(),
) {
  const [read, setRead] = useState<{
    session: string;
    schedules?: Schedule[];
    error?: string;
  }>();
  const session = `${kernel}\n${sessionId}`;
  const reload = useCallback(
    async () =>
      sessionId === undefined
        ? undefined
        : request<{ schedules: Schedule[] }>(
            kernel,
            sessionPath(sessionId),
          ).then(
            ({ schedules }) => setRead({ session, schedules }),
            (error: unknown) =>
              setRead((was) => ({
                ...(was?.session === session ? was : { session }),
                error: errorMessage(error),
              })),
          ),
    [kernel, sessionId, session],
  );
  useEffect(() => void reload(), [reload]);
  const current = read?.session === session ? read : undefined;
  const next = Math.min(
    ...(current?.schedules ?? []).flatMap((s) =>
      s.next_run_at === null ? [] : [s.next_run_at],
    ),
  );
  useEffect(() => {
    if (!Number.isFinite(next)) return;
    // A moment after, for the run to be recorded.
    const timer = setTimeout(
      () => void reload(),
      Math.min(Math.max(next - Date.now(), 0) + 3000, LONGEST),
    );
    return () => clearTimeout(timer);
  }, [next, reload]);
  const andReload = <T>(work: Promise<T>) => work.then(() => reload());
  return {
    schedules: current?.schedules,
    error: current?.error ?? "",
    reload,
    create: (cron: string, prompt: string) =>
      andReload(request(kernel, sessionPath(sessionId!), { cron, prompt })),
    /** `enabled: false` turns it off until it is turned on again. */
    change: (id: string, change: ScheduleChange) =>
      andReload(request(kernel, path(id), change, undefined, "PATCH")),
    remove: (id: string) =>
      andReload(request(kernel, path(id), undefined, undefined, "DELETE")),
  };
}
