import { afterEach, beforeEach, expect, jest, mock, test } from "bun:test";

type Handler = (...args: unknown[]) => void;
const rooms: FakeRoom[] = [];
// Whether a join never ends: neither joined nor failed.
let stuck = false;
class FakeRoom {
  handlers = new Map<string, Handler>();
  connected: string[] = [];
  disconnected = false;
  options: Record<string, unknown>;
  connectOptions: unknown;
  constructor(options: Record<string, unknown>) {
    this.options = options;
    rooms.push(this);
  }
  on(event: string, handler: Handler) {
    this.handlers.set(event, handler);
    return this;
  }
  emit(event: string, ...args: unknown[]) {
    this.handlers.get(event)?.(...args);
  }
  async connect(url: string, token: string, options?: unknown) {
    this.connected.push(`${url} ${token}`);
    this.connectOptions = options;
    if (stuck) await new Promise(() => {});
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
    SignalReconnecting: "signalReconnecting",
    Reconnecting: "reconnecting",
    Reconnected: "reconnected",
    Disconnected: "disconnected",
  },
}));
const { connectRealtime, setNativeNotices } = await import("./realtime");
import type { NativeNotice } from "./realtime";
import { bindCredential, clearCredential } from "./credentials";

let tokens = 0;
const realFetch = globalThis.fetch;
beforeEach(() => {
  rooms.length = 0;
  tokens = 0;
  stuck = false;
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
  setNativeNotices();
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

test("packaged views never open a WebRTC socket, recover reads and ignore notices from an old sign-in", async () => {
  jest.useFakeTimers();
  const kernel = "https://fixture.invalid/w/test";
  const deliveries: ((m: NativeNotice) => void)[] = [];
  const closed: string[] = [];
  setNativeNotices(async (_, token, hear) => {
    deliveries.push(hear);
    return () => {
      closed.push(token!);
    };
  });
  bindCredential(kernel, "first");
  let snapshots = 0,
    reads = 0,
    events = 0;
  const stop = connectRealtime({
    kernel,
    sync: () => snapshots++,
    status: () => {},
    event: () => events++,
    readWhileDisconnected: async () => {
      reads++;
    },
  });
  await flush();
  deliveries[0]!({ type: "live" });
  const data: NativeNotice = {
    type: "packet",
    data: JSON.stringify({
      event_id: "fixture",
      type: "session.changed",
      session_id: "s",
    }),
  };
  deliveries[0]!(data);
  deliveries[0]!(data);
  deliveries[0]!({ type: "offline" });
  jest.advanceTimersByTime(3000);
  await flush();
  expect(reads).toBe(1);
  bindCredential(kernel, "second");
  await flush();
  expect(closed).toEqual(["first"]);
  deliveries[0]!({ type: "live" });
  deliveries[0]!(data);
  expect(snapshots).toBe(1);
  expect(events).toBe(1);
  deliveries[1]!({ type: "live" });
  deliveries[1]!(data);
  expect(events).toBe(2);
  jest.advanceTimersByTime(9000);
  await flush();
  expect(reads).toBe(1);
  expect(rooms.length).toBe(0);
  expect(tokens).toBe(0);
  stop();
  clearCredential(kernel);
  expect(closed).toEqual(["first", "second"]);
});

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

test("a join that never ends is left, and a new room joins with a fresh token", async () => {
  jest.useFakeTimers();
  stuck = true;
  const { log, stop } = start();
  await flush();
  expect(rooms[0]!.connected).toEqual(["ws://127.0.0.1:7880 t1"]);
  expect(log).toEqual([]);
  stuck = false;
  jest.advanceTimersByTime(50_000);
  await flush();
  expect(rooms[0]!.disconnected).toBe(true);
  expect(rooms).toHaveLength(2);
  expect(rooms[1]!.connected).toEqual(["ws://127.0.0.1:7880 t2"]);
  expect(log).toEqual(["status offline", "status live", "sync"]);
  stop();
});

for (const event of ["reconnecting", "signalReconnecting"])
  test(`a room stuck ${event} is left, and a new room joins with a fresh token`, async () => {
    jest.useFakeTimers();
    const { log, stop } = start();
    await flush();
    rooms[0]!.emit(event);
    jest.advanceTimersByTime(50_000);
    await flush();
    expect(rooms[0]!.disconnected).toBe(true);
    expect(rooms).toHaveLength(2);
    expect(rooms[1]!.connected).toEqual(["ws://127.0.0.1:7880 t2"]);
    expect(log.slice(-3)).toEqual(["status offline", "status live", "sync"]);
    // The room left behind no longer speaks for the connection.
    rooms[0]!.emit("reconnecting");
    rooms[0]!.emit("reconnected");
    rooms[0]!.emit("disconnected");
    jest.advanceTimersByTime(120_000);
    await flush();
    expect(rooms).toHaveLength(2);
    expect(log.slice(-3)).toEqual(["status offline", "status live", "sync"]);
    stop();
  });

test("successive signal and transport retries cannot postpone recovery indefinitely", async () => {
  jest.useFakeTimers();
  const { log, stop } = start();
  await flush();
  const old = rooms[0]!;
  for (let i = 0; i < 4; i++) {
    old.emit(i % 2 ? "reconnecting" : "signalReconnecting");
    jest.advanceTimersByTime(12_000);
    await flush();
  }
  expect(old.disconnected).toBe(true);
  expect(rooms.length).toBe(2);
  expect(log.at(-1)).toBe("sync");
  stop();
});

test("a delayed packet from an abandoned room cannot overwrite the current snapshot", async () => {
  jest.useFakeTimers();
  const { log, stop } = start();
  await flush();
  const old = rooms[0]!;
  old.emit("disconnected");
  jest.advanceTimersByTime(1000);
  await flush();
  const before = log.length;
  const event = packet({
    type: "approval.changed",
    event_id: "unique",
    approval_id: "a",
  });
  old.emit("dataReceived", event, undefined, 0, "chat");
  expect(log.length).toBe(before);
  rooms[1]!.emit("dataReceived", event, undefined, 0, "chat");
  expect(log.length).toBe(before + 1);
  stop();
});

test("a slow HTTP read while the room is down never piles up, and recovery stops the fallback", async () => {
  jest.useFakeTimers();
  stuck = true;
  let reads = 0,
    joined = 0;
  const pending = Promise.withResolvers<void>();
  const stop = connectRealtime({
    event: () => {},
    status: () => {},
    sync: () => {
      joined++;
    },
    readWhileDisconnected: async () => {
      reads++;
      await pending.promise;
    },
  });
  await flush();
  jest.advanceTimersByTime(3000);
  await flush();
  expect(reads).toBe(1);
  expect(joined).toBe(0);
  jest.advanceTimersByTime(12000);
  await flush();
  expect(reads).toBe(1);
  stuck = false;
  rooms[0]!.emit("disconnected");
  jest.advanceTimersByTime(1000);
  await flush();
  expect(joined).toBe(1);
  pending.resolve();
  await flush();
  jest.advanceTimersByTime(30000);
  await flush();
  expect(reads).toBe(1);
  stop();
});

test("a room that reconnects in time is kept", async () => {
  jest.useFakeTimers();
  const { stop } = start();
  await flush();
  rooms[0]!.emit("signalReconnecting");
  rooms[0]!.emit("reconnecting");
  jest.advanceTimersByTime(5_000);
  rooms[0]!.emit("reconnected");
  jest.advanceTimersByTime(600_000);
  await flush();
  expect(rooms).toHaveLength(1);
  expect(rooms[0]!.disconnected).toBe(false);
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

test("the chat room never opens the system's audio: a silent context, no media", async () => {
  const stop = connectRealtime({
    event: () => {},
    sync: () => {},
    status: () => {},
  });
  await flush();
  const room = rooms[0]!;
  const mix = room.options.webAudioMix as { audioContext: AudioContext };
  // LiveKit takes the context it is given instead of creating and resuming its own.
  expect(mix.audioContext.state).toBe("running");
  expect(room.connectOptions).toEqual({ autoSubscribe: false });
  stop();
});
