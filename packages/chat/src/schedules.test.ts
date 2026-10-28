import { expect, test } from "bun:test";
import { cronOf, ruleOf } from "./schedules";
import type { ScheduleRule } from "./schedules";

test("the common rules are cron patterns and back", () => {
  const rules: ScheduleRule[] = [
    { every: "hour", minute: 0 },
    { every: "hour", minute: 30 },
    { every: "day", hour: 9, minute: 0 },
    { every: "weekday", hour: 18, minute: 45 },
    { every: "week", day: 1, hour: 7, minute: 5 },
  ];
  for (const rule of rules) expect(ruleOf(cronOf(rule))).toEqual(rule);
  expect(cronOf({ every: "weekday", hour: 9, minute: 0 })).toBe("0 9 * * 1-5");
  // Sunday is 0 or 7; anything else is the owner's own pattern.
  expect(ruleOf("0 9 * * 7")).toEqual({
    every: "week",
    day: 0,
    hour: 9,
    minute: 0,
  });
  expect(ruleOf(" */15 * * * * ")).toEqual({
    every: "custom",
    cron: "*/15 * * * *",
  });
  expect(ruleOf("0 9 1 * *").every).toBe("custom");
  expect(ruleOf("61 9 * * *").every).toBe("custom");
});
