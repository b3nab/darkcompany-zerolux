import { afterEach, beforeEach, expect, jest, mock, test } from "bun:test";

type Handler = (...args: unknown[]) => void;
const rooms: FakeRoom[] = [];
class FakeRoom {
  handlers = new Map<string, Handler>();
  connected: string[] = [];
  disconnected = false;
  constructor() {
    rooms.push(this);
  }
  on(event: string, handler: Handler) {
    this.handlers.set(event, handler);
    return this;
  }
  emit(event: string, ...args: unknown[]) {
    this.handlers.get(event)?.(...args);
  }
  async connect(url: string, token: string) {
    this.connected.push(`${url} ${token}`);
  }
  async disconnect() {
    this.disconnected = true;
  }
}
mock.module("livekit-client", () => ({
  DefaultReconnectPolicy: class {},
  Room: FakeRoom,
  RoomEvent: {
    DataReceived: "dataReceived",
    Reconnecting: "reconnecting",
    Reconnected: "reconnected",
    Disconnected: "disconnected",
  },
}));
const { connectRealtime } = await import("./realtime");

let tokens = 0;
const realFetch = globalThis.fetch;
beforeEach(() => {
  rooms.length = 0;
  tokens = 0;
  globalThis.fetch = (async (input: string) => {
    expect(input).toBe("/api/livekit/token");
    tokens++;
    return Response.json({
      url: "ws://127.0.0.1:7880",
      token: `t${tokens}`,
      expires_at: 0,
    });
  }) as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = realFetch;
  jest.useRealTimers();
});
// Microtasks only: timers may be faked.
const flush = async () => {
  for (let i = 0; i < 50; i++) await Promise.resolve();
};
const packet = (event: object) =>
  new TextEncoder().encode(JSON.stringify(event));

function start() {
  const log: string[] = [];
  const stop = connectRealtime({
    event: (e) => log.push(`event ${e.event_id}`),
    sync: () => log.push("sync"),
    status: (s) => log.push(`status ${s}`),
  });
  return { log, stop };
}

test("joins with a kernel token, then refetches the snapshot", async () => {
  const { log, stop } = start();
  await flush();
  expect(rooms[0]!.connected).toEqual(["ws://127.0.0.1:7880 t1"]);
  expect(log).toEqual(["status live", "sync"]);
  stop();
  expect(rooms[0]!.disconnected).toBe(true);
});

test("delivers each kernel chat event once and ignores anything else", async () => {
  const { log, stop } = start();
  await flush();
  const room = rooms[0]!;
  const event = { event_id: "e1", type: "approval.changed", approval_id: "a" };
  room.emit("dataReceived", packet(event), undefined, 0, "chat");
  room.emit("dataReceived", packet(event), undefined, 0, "chat");
  room.emit(
    "dataReceived",
    packet({ ...event, event_id: "e2" }),
    { identity: "x" },
    0,
    "chat",
  );
  room.emit(
    "dataReceived",
    packet({ ...event, event_id: "e3" }),
    undefined,
    0,
    "other",
  );
  room.emit(
    "dataReceived",
    new TextEncoder().encode("garbage"),
    undefined,
    0,
    "chat",
  );
  expect(log.filter((l) => l.startsWith("event"))).toEqual(["event e1"]);
  stop();
});

test("resyncs after a resumed connection and rejoins with a fresh token after a drop", async () => {
  jest.useFakeTimers();
  const { log, stop } = start();
  await flush();
  rooms[0]!.emit("reconnecting");
  rooms[0]!.emit("reconnected");
  expect(log).toEqual([
    "status live",
    "sync",
    "status connecting",
    "status live",
    "sync",
  ]);
  rooms[0]!.emit("disconnected");
  expect(log.at(-1)).toBe("status offline");
  jest.advanceTimersByTime(1000);
  await flush();
  expect(rooms).toHaveLength(2);
  expect(rooms[1]!.connected).toEqual(["ws://127.0.0.1:7880 t2"]);
  expect(log.slice(-2)).toEqual(["status live", "sync"]);
  // A drop of the old room after replacement does not start another attempt.
  rooms[0]!.emit("disconnected");
  jest.advanceTimersByTime(60_000);
  await flush();
  expect(rooms).toHaveLength(2);
  stop();
});

test("stopping during a join never leaves a connection or a retry behind", async () => {
  jest.useFakeTimers();
  const { stop } = start();
  stop();
  await flush();
  expect(rooms[0]!.connected).toEqual([]);
  jest.advanceTimersByTime(60_000);
  await flush();
  expect(rooms).toHaveLength(1);
});
