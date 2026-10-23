import { expect, test } from "bun:test";
import { briefAgo } from "./chat";

test("a list says when in a few characters: minutes, hours, a weekday, then the day", () => {
  const now = new Date(2026, 9, 23, 12, 0).getTime();
  const before = (minutes: number) => now - minutes * 60_000;
  expect(briefAgo(before(0), now)).toBe("now");
  expect(briefAgo(before(39), now)).toBe("39m");
  expect(briefAgo(before(3 * 60), now)).toBe("3h");
  expect(briefAgo(before(2 * 24 * 60), now)).toBe(
    new Date(before(2 * 24 * 60)).toLocaleDateString(undefined, {
      weekday: "short",
    }),
  );
  expect(briefAgo(new Date(2025, 0, 5).getTime(), now)).toContain("2025");
});
