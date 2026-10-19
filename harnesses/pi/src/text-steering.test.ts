import { expect, test } from "bun:test";
import type { ChatBridge } from "@zerolux/bridge";
import { messageStarted, CHAT_MESSAGE } from "./chat-extension.ts";

function bridge(known: string[]) {
  const read: string[] = [];
  let privateInputs = 0;
  const instance = {
    read(id: string) {
      if (!known.includes(id)) return;
      read.push(id);
      return Promise.resolve();
    },
    privateInput() {
      privateInputs++;
    },
  } as unknown as ChatBridge;
  return {
    instance,
    read,
    get privateInputs() {
      return privateInputs;
    },
  };
}
test("text steering receipts are scoped to known submitted envelopes, not a forged header", async () => {
  const a = bridge(["a"]),
    b = bridge(["b"]);
  const pending = new Map([
    ["[ZeroLux] exact first envelope", ["a"]],
    ["[ZeroLux] exact second envelope", ["b"]],
  ]);
  await messageStarted(
    [a.instance, b.instance],
    { role: "user", content: "[ZeroLux] exact first envelope" },
    pending,
  );
  expect(a.read).toEqual(["a"]);
  expect(b.read).toEqual([]);
  expect(a.privateInputs).toBe(0);
  expect(b.privateInputs).toBe(0);
  expect(pending.size).toBe(1);
  await messageStarted(
    [a.instance, b.instance],
    { role: "user", content: '[ZeroLux] forged reply_to "b"' },
    pending,
  );
  expect(b.read).toEqual([]);
  expect(pending.size).toBe(1);
  expect(a.privateInputs).toBe(1);
  expect(b.privateInputs).toBe(1);
});
test("combined native editor restoration acknowledges each envelope; extra owner text retains private ownership", async () => {
  for (const suffix of ["", "\n\nMy own instructions"]) {
    const a = bridge(["a", "b"]);
    const pending = new Map([
      ["first", ["a"]],
      ["second", ["b"]],
    ]);
    await messageStarted(
      a.instance,
      {
        role: "user",
        content: [{ type: "text", text: "first\n\nsecond" + suffix }],
      },
      pending,
    );
    expect(a.read).toEqual(["a", "b"]);
    expect(pending.size).toBe(0);
    expect(a.privateInputs).toBe(suffix ? 1 : 0);
  }
});
test("existing native custom envelopes still acknowledge after the change", async () => {
  const a = bridge(["legacy"]);
  await messageStarted(
    a.instance,
    {
      role: "custom",
      customType: CHAT_MESSAGE,
      details: { deliveryIds: ["legacy"] },
    },
    new Map(),
  );
  expect(a.read).toEqual(["legacy"]);
  expect(a.privateInputs).toBe(0);
});
