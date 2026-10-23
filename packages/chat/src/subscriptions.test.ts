import { expect, test } from "bun:test";
import {
  headline,
  limitName,
  pace,
  planName,
  resetsIn,
  severityOf,
  type PlanLimit,
  type Subscription,
} from "./subscriptions";

const HOUR = 3_600_000;
const limit = (fields: Partial<PlanLimit>): PlanLimit => ({
  kind: "weekly_all",
  group: "weekly",
  label: null,
  percent: 50,
  resets_at: null,
  severity: null,
  active: null,
  ...fields,
});

test("a plan and its limits read as people say them", () => {
  expect(planName("max")).toBe("Max");
  expect(planName("pro_lite")).toBe("Pro Lite");
  expect(planName(null)).toBe("");
  expect(limitName(limit({ group: "session", kind: "session" }))).toBe(
    "Session",
  );
  expect(limitName(limit({ kind: "weekly_scoped", label: "Opus" }))).toBe(
    "Week · Opus",
  );
});

test("the headline is the server's, else the limit nearest its end", () => {
  const plan = (limits: PlanLimit[]) => ({ limits }) as Subscription;
  const week = limit({ percent: 61 });
  const session = limit({ group: "session", percent: 90 });
  expect(headline(plan([week, session]))).toBe(session);
  expect(
    headline(plan([limit({ ...week, active: true }), session]))!.percent,
  ).toBe(61);
  expect(severityOf(limit({ percent: 80 }))).toBe("warning");
  expect(severityOf(limit({ percent: 80, severity: "normal" }))).toBe("normal");
});

test("a week's pace says when it runs out at this rate, if before its reset", () => {
  const now = Date.UTC(2026, 9, 23, 12);
  // Half the week gone and 74% used: it ends a day and a half before the reset.
  const fast = pace(limit({ percent: 74, resets_at: now + 84 * HOUR }), now)!;
  expect(fast.expected).toBeCloseTo(50);
  expect(fast.runsOut).toBeCloseTo(now + (26 / 74) * 84 * HOUR);
  expect(
    pace(limit({ percent: 30, resets_at: now + 84 * HOUR }), now)!.runsOut,
  ).toBeUndefined();
  // Too early in the week, or a session: no pace.
  expect(pace(limit({ resets_at: now + 167 * HOUR }), now)).toBeUndefined();
  expect(
    pace(limit({ group: "session", resets_at: now + HOUR }), now),
  ).toBeUndefined();
});

test("a reset within a day is a countdown", () => {
  const now = Date.UTC(2026, 9, 23, 12);
  expect(resetsIn(now + 2 * HOUR + 10 * 60_000, now)).toBe("2h 10m");
  expect(resetsIn(now + 42 * 60_000, now)).toBe("42m");
  expect(resetsIn(now + 30_000, now)).toBe("now");
  expect(resetsIn(now + 3 * 24 * HOUR, now)).toMatch(/\d\d:\d\d/);
});
