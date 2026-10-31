import { expect, test } from "bun:test";
import { sharedRead } from "./shared-read";

/** A load whose reads finish when told, counting how many ran at once. */
function slow() {
  const pending: (() => void)[] = [];
  const state = { reads: 0, running: 0, most: 0, fail: false };
  const load = async (kernel: string) => {
    state.reads++;
    state.running++;
    state.most = Math.max(state.most, state.running);
    await new Promise<void>((resolve) => pending.push(resolve));
    state.running--;
    if (state.fail) throw new Error("unreachable");
    return `${kernel}:${state.reads}`;
  };
  const finish = async () => {
    while (pending.length) {
      pending.shift()!();
      await Bun.sleep(0);
    }
  };
  return { load, state, finish };
}

test("one read at a time for a kernel, and asking again while it runs reads once more after", async () => {
  const { load, state, finish } = slow();
  const asked = [
    sharedRead(load, "k1"),
    sharedRead(load, "k1"),
    sharedRead(load, "k1"),
    sharedRead(load, "k1"),
  ];
  await finish();
  await Promise.all(asked);
  expect(state.reads).toBe(2);
  expect(state.most).toBe(1);
});

test("a screen that opens joins the read under way and asks for no other", async () => {
  const { load, state, finish } = slow();
  const asked = [
    sharedRead(load, "k2"),
    sharedRead(load, "k2", true),
    sharedRead(load, "k2", true),
  ];
  await finish();
  await Promise.all(asked);
  expect(state.reads).toBe(1);
});

test("each kernel is read on its own", async () => {
  const { load, state, finish } = slow();
  const asked = [sharedRead(load, "k3"), sharedRead(load, "k4")];
  await finish();
  await Promise.all(asked);
  expect(state.reads).toBe(2);
  expect(state.most).toBe(2);
});
