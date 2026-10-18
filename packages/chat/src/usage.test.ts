import { expect, test } from "bun:test";
import { percent, tokenCount, usdCost } from "./usage";

test("token counts read short, as people say them", () => {
  expect(tokenCount(950)).toBe("950");
  expect(tokenCount(1000)).toBe("1k");
  expect(tokenCount(1500)).toBe("1.5k");
  expect(tokenCount(9_960)).toBe("10k");
  expect(tokenCount(42_000)).toBe("42k");
  expect(tokenCount(999_600)).toBe("1M");
  expect(tokenCount(1_234_567)).toBe("1.2M");
});

test("costs in dollars, and a share as a percentage", () => {
  expect(usdCost(0)).toBe("$0.00");
  expect(usdCost(0.001)).toBe("<$0.01");
  expect(usdCost(0.5)).toBe("$0.50");
  expect(usdCost(12.3)).toBe("$12.30");
  expect(percent(0.214)).toBe("21%");
});
