import { expect, test } from "bun:test";
import { startsHere } from "./hosts";
import type { Host } from "./hosts";

const host = (person_id: string, open: boolean, here = true): Host => ({
  id: `${person_id}-host`,
  name: "Workstation",
  person_id,
  open,
  created_at: 1,
  seen_at: 1,
  here,
});

test("sessions start on the kernel's computer for its person, or for all when it is open", () => {
  expect(startsHere([host("owner", false)], "owner")).toBe(true);
  expect(startsHere([host("owner", false)], "birch")).toBe(false);
  expect(startsHere([host("owner", true)], "birch")).toBe(true);
  // Another computer of one's own is not where the kernel runs.
  expect(startsHere([host("birch", false, false)], "birch")).toBe(false);
  expect(startsHere(undefined, "owner")).toBe(false);
});
