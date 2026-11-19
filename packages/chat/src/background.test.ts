import { afterEach, expect, test } from "bun:test";
import { parseEvent } from "./chat";
import { setKernelFetch } from "./client";
import {
  backgroundEnded,
  toldLine,
  plainOutput,
  readBackgroundOutput,
} from "./background";
import type { BackgroundOutput } from "./background";

afterEach(() => setKernelFetch());

const kernel = "http://192.0.2.4:4400";

/** A background command whose output the kernel gives in `pieces`, by the offsets asked, noting each. */
function output(pieces: Record<number, BackgroundOutput>) {
  const asked: number[] = [];
  setKernelFetch(async (url) => {
    const after = Number(new URL(String(url)).searchParams.get("after"));
    asked.push(after);
    return Response.json({ background_command: {}, output: pieces[after] });
  });
  return asked;
}

test("a background command's output is read on, piece by piece, to the end there is now", async () => {
  const asked = output({
    0: { start: 0, text: "one\n", next: 4, end: 9 },
    4: { start: 4, text: "two\n", next: 8, end: 9 },
    8: { start: 8, text: "3", next: 9, end: 9 },
  });
  const at = await readBackgroundOutput("b1", { text: "", next: 0 }, kernel);
  expect(at).toEqual({ text: "one\ntwo\n3", next: 9 });
  expect(asked).toEqual([0, 4, 8]);
});

test("a read goes on from where the last one stopped", async () => {
  const asked = output({ 4: { start: 4, text: "two", next: 7, end: 7 } });
  const at = await readBackgroundOutput("b1", { text: "one", next: 4 }, kernel);
  expect(at).toEqual({ text: "onetwo", next: 7 });
  expect(asked).toEqual([4]);
});

test("two reads at once take each piece once", async () => {
  output({
    0: { start: 0, text: "one\n", next: 4, end: 8 },
    4: { start: 4, text: "two\n", next: 8, end: 8 },
  });
  const at = { text: "", next: 0 };
  await Promise.all([
    readBackgroundOutput("b1", at, kernel),
    readBackgroundOutput("b1", at, kernel),
  ]);
  expect(at).toEqual({ text: "one\ntwo\n", next: 8 });
});

test("a character cut at the end waits for the next read instead of asking again", async () => {
  const asked = output({ 3: { start: 3, text: "", next: 3, end: 4 } });
  const at = await readBackgroundOutput("b1", { text: "abc", next: 3 }, kernel);
  expect(at.next).toBe(3);
  expect(asked).toEqual([3]);
});

test("only the last part of a long output is kept", async () => {
  output({
    0: { start: 0, text: "x".repeat(250_000), next: 250_000, end: 250_000 },
  });
  const at = await readBackgroundOutput("b1", { text: "", next: 0 }, kernel);
  expect(at.text.length).toBe(200_000);
  expect(at.next).toBe(250_000);
});

test("a background command's notice is an event once per state", () => {
  const notice = (status: string) =>
    parseEvent(
      new TextEncoder().encode(
        JSON.stringify({
          type: "background_command.changed",
          background_command_id: "b1",
          session_id: "s1",
          status,
        }),
      ),
    )?.event_id;
  expect(notice("running")).toBe(notice("running"));
  expect(notice("exited")).not.toBe(notice("running"));
});

test("output reads as plain text: no escape codes, each line as a carriage return last left it", () => {
  expect(
    plainOutput(
      "\x1b[32mok\x1b[0m\n\x1b]0;title\x07 10%\r 50%\r100%\ndone\r\n",
    ),
  ).toBe("ok\n100%\ndone\n");
});

test("how a background command ended is read back from what ZeroLux told its session", () => {
  const notice =
    "Background command 4b1ac3ce-5936 ended: exit code 3, after 117 s.\n$ cargo test\n  --all\n```\nrunning 2 tests\n```text\nfailed\n```";
  const ended = backgroundEnded(notice)!;
  expect(ended.command).toBe("cargo test\n  --all");
  expect(ended.exit).toBe(3);
  expect(ended.seconds).toBe(117);
  expect(ended.output).toBe("running 2 tests\n```text\nfailed");
  // One whose exit is not known, and with nothing printed.
  expect(
    backgroundEnded(
      "Background command x ended: exit code unknown, after 0 s.\n$ true\n```\n\n```",
    ),
  ).toEqual({ command: "true", exit: null, seconds: 0, output: "" });
  // Anything else ZeroLux says is not one.
  expect(backgroundEnded("Agent /root/a completed")).toBeUndefined();
  // In a line: the command and how it ended; anything else, its first line.
  expect(toldLine(notice)).toBe("cargo test · exit 3");
  expect(toldLine("CI passed for commit abc on main:\n- CI: success")).toBe(
    "CI passed for commit abc on main:",
  );
});
