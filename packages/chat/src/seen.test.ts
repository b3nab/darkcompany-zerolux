import { expect, test } from "bun:test";
import { keepSeenIn, markSeen } from "./seen";

test("a session is seen up to its latest output, and a client can keep it", () => {
  const saved: Record<string, number>[] = [];
  keepSeenIn({ aspen: 100, broken: "soon" }, (all) => saved.push(all));
  markSeen("aspen", 90);
  markSeen("birch", 50);
  markSeen("aspen", 120);
  expect(saved).toEqual([
    { aspen: 100, birch: 50 },
    { aspen: 120, birch: 50 },
  ]);
});
