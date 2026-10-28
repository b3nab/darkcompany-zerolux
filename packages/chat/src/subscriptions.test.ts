import { expect, test } from "bun:test";
import {
  headline,
  pace,
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
