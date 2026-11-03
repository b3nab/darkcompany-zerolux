import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { QueueItem } from "@zerolux/chat";
import { SessionQueue, moved, sendModeOf } from "./SessionQueue";

const item = (id: string, text: string): QueueItem => ({
  id,
  text,
  images: [],
  created_at: 1,
  author_id: "owner",
});
const queue = [item("q1", "Run the tests"), item("q2", "Then the linter")];
const done = async () => true;
const act = {
  edit: done,
  remove: done,
  send: done,
  order: done,
  clear: done,
};

test("Enter queues an input for a turn of its own; with ⌘ or Ctrl it goes into the turn in progress", () => {
  const plain = { metaKey: false, ctrlKey: false };
  expect(sendModeOf(plain, true)).toBe("queue");
  expect(sendModeOf({ ...plain, metaKey: true }, true)).toBe("steer");
  expect(sendModeOf({ ...plain, ctrlKey: true }, true)).toBe("steer");
  // At rest it is queued too: with nothing before it, ZeroLux starts its turn at once.
  expect(sendModeOf({ ...plain, metaKey: true }, false)).toBe("queue");
});

test("a queued input dragged to another place puts the queue in that order", () => {
  expect(moved(["a", "b", "c"], 0, 2)).toEqual(["b", "c", "a"]);
  expect(moved(["a", "b", "c"], 2, 0)).toEqual(["c", "a", "b"]);
});

test("whoever may write moves, sends, edits and removes each queued input, and empties the queue; others only read it", () => {
  const writer = renderToStaticMarkup(
    <SessionQueue queue={queue} steering={[]} busy={false} act={act} />,
  );
  const reader = renderToStaticMarkup(
    <SessionQueue queue={queue} steering={[]} busy={false} />,
  );
  // Four controls each, and one for the whole queue.
  expect(writer.match(/<button/g)).toHaveLength(queue.length * 4 + 1);
  expect(writer.match(/draggable="true"/g)).toHaveLength(queue.length);
  expect(reader).not.toContain("<button");
  expect(reader).not.toContain('draggable="true"');
  expect(reader.match(/<li/g)).toHaveLength(queue.length);
});

test("words already given to the turn in progress show below the queue, and cannot be changed", () => {
  const html = renderToStaticMarkup(
    <SessionQueue
      queue={[]}
      steering={[{ id: "s1", text: "Use the cache", changeable: false }]}
      busy={false}
      act={act}
    />,
  );
  expect(html.match(/<li/g)).toHaveLength(1);
  expect(html).not.toContain("<button");
});
