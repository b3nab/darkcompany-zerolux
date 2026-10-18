import { expect, test } from "bun:test";
import { followTerminal, terminalNotice, terminalResync } from "./terminals";
import type { TerminalOutput } from "./terminals";

const settle = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

test("a followed terminal gets its output in order, in bounded pieces, until it ends", async () => {
  // What the kernel keeps: one byte per letter, read three at a time.
  let kept = "hello";
  let ended = false;
  const reads: number[] = [];
  const read = async (after: number): Promise<TerminalOutput> => {
    reads.push(after);
    const data = kept.slice(after, after + 3);
    const next = after + data.length;
    return {
      start: 0,
      data: btoa(data),
      next,
      ended: ended && next === kept.length,
    };
  };
  const written: string[] = [];
  let finished = 0;
  const stop = followTerminal(
    "aspen",
    read,
    (data) => written.push(atob(data)),
    () => finished++,
  );
  await settle();
  expect(written.join("")).toBe("hello");
  expect(reads).toEqual([0, 3, 5]);
  // More output: the notice reads on from where it stopped.
  kept = "hello world";
  terminalNotice({
    type: "terminal.output",
    terminal_id: "aspen",
    session_id: "s",
    end: 11,
    ended: false,
  });
  await settle();
  expect(written.join("")).toBe("hello world");
  // A notice for another terminal changes nothing; a reconnection reads on too.
  terminalNotice({
    type: "terminal.output",
    terminal_id: "birch",
    session_id: "s",
    end: 99,
    ended: false,
  });
  kept = "hello world!";
  ended = true;
  terminalResync();
  await settle();
  expect(written.join("")).toBe("hello world!");
  expect(finished).toBe(1);
  stop();
});
