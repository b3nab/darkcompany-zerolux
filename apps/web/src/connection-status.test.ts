import { afterEach, expect, test } from "bun:test";
import { ApiError, Unreachable, setKernelFetch } from "@zerolux/chat";
import { connectionStatus, reachabilityAfter } from "./connection-status";

afterEach(() => setKernelFetch());
test("a dropped notice room doesn't mark a reachable kernel down, and a denied read is still an answer", async () => {
  let calls = 0;
  setKernelFetch(async (url) => {
    calls++;
    expect(url).toBe("/api/health");
    return Response.json({});
  });
  expect(await reachabilityAfter(new ApiError("", 403), "")).toBe("reachable");
  expect(calls).toBe(0);
  const reached = await reachabilityAfter(new Unreachable(), "");
  expect(calls).toBe(1);
  expect(reached).toBe("reachable");
  expect(connectionStatus(reached, false).tone).toBe(
    connectionStatus(reached, true).tone,
  );
  setKernelFetch(async () => {
    throw TypeError();
  });
  const down = await reachabilityAfter(new Unreachable(), "");
  expect(down).toBe("unreachable");
  expect(connectionStatus(down, true).tone).not.toBe(
    connectionStatus(reached, true).tone,
  );
});
