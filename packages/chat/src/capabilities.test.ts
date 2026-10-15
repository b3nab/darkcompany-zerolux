import { expect, test } from "bun:test";
import { capabilityStatus } from "./capabilities";

test("every known feature says whether this kernel has it, and unknown ones still show", () => {
  const status = capabilityStatus(["chat-v1", "auth-v1", "console-v1"]);
  const available = (id: string) =>
    status.find((capability) => capability.id === id)?.available;
  expect(available("chat-v1")).toBe(true);
  expect(available("auth-v1")).toBe(true);
  expect(available("meetings-v1")).toBe(false);
  expect(available("storage-v1")).toBe(false);
  expect(status.at(-1)).toEqual({
    id: "console-v1",
    name: "console-v1",
    description: "",
    available: true,
  });
});
