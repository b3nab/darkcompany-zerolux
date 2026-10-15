import { expect, test } from "bun:test";
import type { ChatSession } from "./chat";
import { consoleSessions } from "./presence";

const session = (
  id: string,
  status: ChatSession["status"],
  activity: ChatSession["activity"] = null,
): ChatSession => ({
  id,
  actor_id: "aspen",
  host_id: null,
  harness: "pi",
  native_session_id: `native-${id}`,
  title: id,
  workspace: "/home/owner/work",
  status,
  attention_reason: null,
  activity,
  waiting: 0,
});

test("the console lists live sessions working first, and keeps the stopped ones apart", () => {
  const { live, stopped } = consoleSessions([
    session("starting", "connecting"),
    session("idle", "connected", "idle"),
    session("done", "stopped"),
    session("busy", "connected", "working"),
  ]);
  expect(live.map((s) => s.id)).toEqual(["busy", "idle", "starting"]);
  expect(stopped.map((s) => s.id)).toEqual(["done"]);
});
