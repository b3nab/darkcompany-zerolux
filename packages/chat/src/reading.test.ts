import { expect, test } from "bun:test";
import { readPositions } from "./reading";

test("a read position goes to the kernel once, the furthest last, never behind it", async () => {
  const sent: [string, number][] = [];
  let finish = () => {};
  const positions = readPositions((path, position) => {
    sent.push([path, position]);
    return new Promise<void>((done) => (finish = done));
  });
  positions.heard("/conversations/a/read", 4);
  expect(positions.move("/conversations/a/read", 3)).toBe(false);
  expect(positions.move("/conversations/a/read", 5)).toBe(true);
  // While one is on its way, only the furthest of the next ones follows it.
  positions.move("/conversations/a/read", 6);
  positions.move("/conversations/a/read", 7);
  finish();
  await Bun.sleep(0);
  finish();
  await Bun.sleep(0);
  expect(sent).toEqual([
    ["/conversations/a/read", 5],
    ["/conversations/a/read", 7],
  ]);
});

test("a position the kernel did not take is sent again with the next move", async () => {
  const sent: number[] = [];
  const positions = readPositions(async (_, position) => {
    sent.push(position);
    if (sent.length === 1) throw new Error("offline");
  });
  positions.move("/sessions/a/seen", 10);
  await Bun.sleep(0);
  expect(positions.move("/sessions/a/seen", 10)).toBe(true);
  await Bun.sleep(0);
  expect(sent).toEqual([10, 10]);
});
