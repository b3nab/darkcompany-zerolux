import { expect, test } from "bun:test";
import { composerAction } from "./composer";

const at = {
  filled: false,
  interruptible: false,
  recordable: true,
  transcribing: false,
};

test("an empty box records, a filled one sends, and a working agent is interrupted", () => {
  expect(composerAction(at)).toBe("record");
  expect(composerAction({ ...at, filled: true })).toBe("send");
  expect(composerAction({ ...at, interruptible: true })).toBe("interrupt");
  expect(composerAction({ ...at, interruptible: true, filled: true })).toBe(
    "send",
  );
  // Without a way to record, the empty box keeps Send, which waits for words.
  expect(composerAction({ ...at, recordable: false })).toBe("send");
});

test("while recording the button ends it, and it waits while transcribing", () => {
  expect(composerAction({ ...at, filled: true, voice: "dictation" })).toBe(
    "write",
  );
  expect(composerAction({ ...at, interruptible: true, voice: "message" })).toBe(
    "send",
  );
  expect(
    composerAction({ ...at, voice: "dictation", transcribing: true }),
  ).toBe("transcribing");
});
