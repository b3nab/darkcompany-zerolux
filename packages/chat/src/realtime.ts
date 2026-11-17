import { DefaultReconnectPolicy, Room, RoomEvent } from "livekit-client";
import { request } from "./client";
import { parseEvent } from "./chat";
import type { ChatEvent } from "./chat";

export type RealtimeStatus = "connecting" | "live" | "offline";

/**
 * The chat room carries data only. LiveKit opens and resumes an audio context on every
 * connection, for playback; in a WebKit window, resuming one waits on the system's audio and
 * can freeze the page outright. This context plays nothing and never opens the system's audio,
 * and the room subscribes to no media, so nothing ever plays through it.
 */
const SILENT = {
  state: "running",
  resume: async () => {},
  suspend: async () => {},
  close: async () => {},
  addEventListener: () => {},
  removeEventListener: () => {},
} as unknown as AudioContext;

/**
 * How long a room may take to join, or to reconnect in place. LiveKit gives up by itself well
 * within it; a room still on its way past it is stuck, and is left for a new one.
 */
const PATIENCE = 45_000;

/**
 * Joins the kernel's LiveKit room and reports chat events. `sync` runs after
 * every (re)connection so callers refetch what packets cannot replay.
 * Returns a function that disconnects for good.
 */
export function connectRealtime(handlers: {
  /** The kernel whose room this joins; the page's own origin when empty. */
  kernel?: string;
  event: (event: ChatEvent) => void;
  sync: () => void;
  status: (status: RealtimeStatus) => void;
}): () => void {
  const seen = new Set<string>();
  let room: Room | undefined;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let patience: ReturnType<typeof setTimeout> | undefined;
  let attempt = 0;
  let stopped = false;

  function reconnect() {
    clearTimeout(patience);
    room = undefined;
    if (stopped) return;
    handlers.status("offline");
    retry = setTimeout(start, Math.min(10_000, 1000 * 2 ** attempt++));
  }
  // The connection never rests on a room's word alone: one that neither gets live in time
  // nor says it failed is left, and a new one joins with a fresh token.
  function expect(current: Room) {
    clearTimeout(patience);
    patience = setTimeout(() => {
      if (room !== current) return;
      reconnect();
      void current.disconnect().catch(() => {});
    }, PATIENCE);
  }
  async function start() {
    // Resume in place only briefly: after a kernel restart the old URL and
    // keys are gone, and rejoining with a fresh token is what recovers.
    const current = new Room({
      reconnectPolicy: new DefaultReconnectPolicy([0, 300, 1200, 2700]),
      webAudioMix: { audioContext: SILENT },
    });
    room = current;
    expect(current);
    current.on(RoomEvent.DataReceived, (payload, participant, _, topic) => {
      // Only the kernel publishes chat events; participants cannot.
      if (topic !== "chat" || participant) return;
      const event = parseEvent(payload);
      if (!event || seen.has(event.event_id)) return;
      seen.add(event.event_id);
      if (seen.size > 1000) seen.delete(seen.values().next().value!);
      handlers.event(event);
    });
    // A room already left no longer speaks for the connection.
    current.on(RoomEvent.SignalReconnecting, () => {
      if (room === current) expect(current);
    });
    current.on(RoomEvent.Reconnecting, () => {
      if (room !== current) return;
      handlers.status("connecting");
      expect(current);
    });
    current.on(RoomEvent.Reconnected, () => {
      if (room !== current) return;
      clearTimeout(patience);
      handlers.status("live");
      handlers.sync();
    });
    current.on(RoomEvent.Disconnected, () => {
      if (room === current) reconnect();
    });
    try {
      // A fresh token each time: the kernel may have restarted with new keys.
      const { url, token } = await request<{ url: string; token: string }>(
        handlers.kernel ?? "",
        "/livekit/token",
      );
      if (room !== current) return;
      await current.connect(url, token, { autoSubscribe: false });
      if (room !== current) return void current.disconnect().catch(() => {});
      clearTimeout(patience);
      attempt = 0;
      handlers.status("live");
      handlers.sync();
    } catch {
      if (room === current) reconnect();
    }
  }
  void start();
  return () => {
    stopped = true;
    clearTimeout(retry);
    clearTimeout(patience);
    const current = room;
    room = undefined;
    void current?.disconnect();
  };
}
