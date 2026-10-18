import { expect, test } from "bun:test";
import {
  followTerminal,
  terminalNotice,
  terminalResync,
  terminalWriter,
} from "./terminals";
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

test("what is typed while a write is out goes next, together, in order", async () => {
  const sent: string[] = [];
  let release = () => {};
  const write = terminalWriter(
    (data) =>
      new Promise<void>((done) => {
        sent.push(data);
        release = done;
      }),
  );
  const first = write("l");
  void write("s");
  void write(" -la\r");
  expect(sent).toEqual(["l"]);
  release();
  await settle();
  expect(sent).toEqual(["l", "s -la\r"]);
  release();
  await first;
  // A failed write rejects; what is typed after it goes on.
  const failing = terminalWriter(async (data) => {
    if (data === "x") throw new Error("gone");
    sent.push(data);
  });
  await expect(failing("x")).rejects.toThrow("gone");
  await failing("y");
  expect(sent.at(-1)).toBe("y");
});
