import { expect, spyOn, test } from "bun:test";
import { processExists } from "./process-state.ts";

test("only ESRCH proves death; permission and other failures remain ambiguous", () => {
  const probe = spyOn(process, "kill");
  try {
    for (const code of ["EPERM", "EACCES", "EIO", "ESRCH"]) {
      probe.mockImplementation(() => {
        throw Object.assign(new Error("fixture"), { code });
      });
      expect(processExists(123)).toBe(code !== "ESRCH");
      expect(probe).toHaveBeenLastCalledWith(123, 0);
    }
    const calls = probe.mock.calls.length;
    for (const value of [0, -1, 1.5, NaN])
      expect(() => processExists(value)).toThrow();
    expect(probe.mock.calls).toHaveLength(calls);
  } finally {
    probe.mockRestore();
  }
});
