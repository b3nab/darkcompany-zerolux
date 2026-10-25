import { useSyncExternalStore } from "react";
import { errorMessage } from "@zerolux/chat";
import { desktopConnection } from "./desktop";
import { trayPanel } from "./tray";

export type UpdateChannel = "nightly" | "beta" | "stable";
export interface BuildInfo {
  version: string;
  channel: UpdateChannel;
  commit: string;
  built_at: string;
  dirty: boolean;
}
export interface UpdateState {
  channel: UpdateChannel;
  current: BuildInfo;
  phase:
    | "idle"
    | "checking"
    | "available"
    | "downloading"
    | "ready"
    | "installing"
    | "error";
  available?: {
    version: string;
    commit: string;
    built_at: string;
    notes: string;
  } | null;
  downloaded?: number;
  total?: number | null;
  error?: string | null;
  checkedAt?: string | null;
}
type Command =
  | "update_status"
  | "update_check"
  | "update_channel"
  | "update_download"
  | "update_install";
interface Transport {
  invoke: (
    command: Command,
    args?: { channel: UpdateChannel },
  ) => Promise<UpdateState>;
  listen: (receive: (state: UpdateState) => void) => Promise<() => void>;
}
interface Snapshot {
  state?: UpdateState;
  error?: string;
  pending: boolean;
}
const empty: Snapshot = { pending: false };

/** One native subscription per page, shared by its header, settings and tray controls. */
export function updateStore(transport: Transport) {
  let value = empty;
  let generation = 0;
  let revision = 0;
  let stop: (() => void) | undefined;
  const listeners = new Set<() => void>();
  const publish = (next: Snapshot) => {
    value = next;
    for (const listener of listeners) listener();
  };
  const receive = (state: UpdateState) => {
    revision++;
    publish({ state, pending: value.pending });
  };
  const fail = (error: unknown) =>
    publish({ ...value, error: errorMessage(error) });
  return {
    snapshot: () => value,
    subscribe(listener: () => void) {
      listeners.add(listener);
      if (listeners.size === 1) {
        const run = ++generation;
        void transport
          .listen((state) => {
            if (run === generation) receive(state);
          })
          .then(async (unlisten) => {
            if (run !== generation) return unlisten();
            stop = unlisten;
            const before = revision;
            const state = await transport.invoke("update_status");
            if (run === generation && before === revision) receive(state);
          })
          .catch((error: unknown) => {
            if (run === generation) fail(error);
          });
      }
      return () => {
        listeners.delete(listener);
        if (!listeners.size) {
          generation++;
          stop?.();
          stop = undefined;
        }
      };
    },
    async act(
      command: Exclude<Command, "update_status">,
      channel?: UpdateChannel,
    ) {
      if (value.pending) return;
      publish({ state: value.state, pending: true });
      const before = revision;
      try {
        const state = await transport.invoke(
          command,
          channel ? { channel } : undefined,
        );
        if (before === revision) receive(state);
      } catch (error) {
        fail(error);
      } finally {
        publish({ ...value, pending: false });
      }
    },
  };
}

const native = updateStore({
  invoke: async (command, args) => {
    const { invoke } = await import("@tauri-apps/api/core");
    return invoke<UpdateState>(command, args);
  },
  listen: async (receive) => {
    const { getCurrentWebviewWindow } =
      await import("@tauri-apps/api/webviewWindow");
    return getCurrentWebviewWindow().listen<UpdateState>(
      "zerolux-update",
      (event) => receive(event.payload),
    );
  },
});
const nothing = () => () => {};

export function useUpdates() {
  const desktop = !!(desktopConnection() || trayPanel());
  const snapshot = useSyncExternalStore(
    desktop ? native.subscribe : nothing,
    native.snapshot,
    () => empty,
  );
  return { ...snapshot, desktop, act: native.act };
}

export const updating = (state?: UpdateState) =>
  !!state && ["checking", "downloading", "installing"].includes(state.phase);

export const updateOffered = (state?: UpdateState) => !!state?.available;
