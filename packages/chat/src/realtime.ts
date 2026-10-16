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
  let attempt = 0;
  let stopped = false;

  function reconnect() {
    room = undefined;
    if (stopped) return;
    handlers.status("offline");
    retry = setTimeout(start, Math.min(10_000, 1000 * 2 ** attempt++));
  }
  async function start() {
    // Resume in place only briefly: after a kernel restart the old URL and
    // keys are gone, and rejoining with a fresh token is what recovers.
    const current = new Room({
      reconnectPolicy: new DefaultReconnectPolicy([0, 300, 1200, 2700]),
      webAudioMix: { audioContext: SILENT },
    });
    room = current;
    current.on(RoomEvent.DataReceived, (payload, participant, _, topic) => {
      // Only the kernel publishes chat events; participants cannot.
      if (topic !== "chat" || participant) return;
      const event = parseEvent(payload);
      if (!event || seen.has(event.event_id)) return;
      seen.add(event.event_id);
      if (seen.size > 1000) seen.delete(seen.values().next().value!);
      handlers.event(event);
    });
    current.on(RoomEvent.Reconnecting, () => handlers.status("connecting"));
    current.on(RoomEvent.Reconnected, () => {
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
      if (stopped) return;
      await current.connect(url, token, { autoSubscribe: false });
      if (stopped) return void current.disconnect();
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
    const current = room;
    room = undefined;
    void current?.disconnect();
  };
}
