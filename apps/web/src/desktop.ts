import { useEffect, useRef, useState } from "react";
import { currentDrafts } from "@zerolux/chat";
import { navigationBlock } from "./navigation-guard";

/** Optional desktop context. No native API or other workspace's configuration is exposed. */
declare global {
  interface Window {
    zeroluxDesktop?: Readonly<{
      profileId: string;
      /** The ZeroLux it reaches: its instance, or an older kernel's one workspace. */
      instanceId: string;
      managed?: boolean;
      kernelUrl?: string;
      platform?: "macos" | "windows" | "linux";
    }>;
    zeroluxWorkspaceState?: () => {
      canLeave: boolean;
      reason?: string;
      drafts: Record<string, string>;
    };
    zeroluxRestoredDrafts?: Record<string, string>;
  }
}

export function desktopConnection() {
  return typeof window !== "undefined" ? window.zeroluxDesktop : undefined;
}

/**
 * The sign-in of this window's kernel, kept by the desktop in the system's credential store
 * across restarts, one for each kernel. Where the store is missing or refuses, it lasts while
 * the window is open.
 */
export function desktopSignIn() {
  let kept: string | null = null;
  const instanceId = desktopConnection()?.instanceId;
  const call = <T>(command: string, args: Record<string, unknown>) =>
    import("@tauri-apps/api/core").then(({ invoke }) =>
      invoke<T>(command, args),
    );
  return {
    async read() {
      const saved = await call<string | null>("read_workspace_credential", {
        workspaceId: instanceId,
      }).catch((error: unknown) => {
        console.warn("The saved sign-in could not be read:", error);
        return null;
      });
      return saved ?? kept;
    },
    async write(_kernel: string, token: string | null) {
      kept = token;
      await call("write_workspace_credential", {
        workspaceId: instanceId,
        token,
      }).catch((error: unknown) =>
        console.warn("The sign-in could not be kept:", error),
      );
    },
  };
}

/** A web address opened outside the app: by the system browser in the desktop, else a new tab. */
export async function openLink(url: string) {
  if (!desktopConnection()) {
    window.open(url, "_blank", "noopener");
    return;
  }
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("open_link", { url });
}

/** Where this page's kernel is: the desktop names it, a browser uses the page's own origin. */
export const kernelAddress = () => desktopConnection()?.kernelUrl ?? "";

/** The desktop app on the computer its kernel runs on: that computer's folders are this one's. */
export function kernelHere() {
  try {
    const host = new URL(kernelAddress()).hostname;
    return ["localhost", "127.0.0.1", "[::1]"].includes(host);
  } catch {
    return false;
  }
}

/** A folder chosen in the system's own panel, from `start`; nothing when it is cancelled. */
export async function chooseFolder(start?: string) {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<string | null>("choose_folder", { start: start ?? null });
}

/**
 * Where an extension's page is opened: in the desktop through the app's own scheme, which
 * serves it from this workspace's kernel only; in a browser at the kernel's address.
 */
export function extensionUiAddress(url: string) {
  const desktop = desktopConnection();
  // The workspace's own, under its `/w/<id>`, as the kernel serves it.
  const file =
    /^[a-z]+:\/\/[^/]+((?:\/w\/[^/]+)?)\/api\/extension-ui\/(.+)$/.exec(url);
  if (!desktop || !file) return url;
  const path = `${file[1]}/${file[2]}`.replace(/^\//, "");
  return desktop.platform === "windows"
    ? `http://zerolux-ui.localhost/${path}`
    : `zerolux-ui://localhost/${path}`;
}

/**
 * What the desktop tells this window by `event`: the page to show, from the tray's panel
 * (`zerolux-open`), or a command of the menu (`zerolux-command`).
 */
export function useDesktopEvent(
  event: string,
  receive: (payload: string) => void,
) {
  const latest = useRef(receive);
  latest.current = receive;
  useEffect(() => {
    if (!desktopConnection()) return;
    let live = true;
    let stop: (() => void) | undefined;
    void import("@tauri-apps/api/webviewWindow").then(
      async ({ getCurrentWebviewWindow }) => {
        const unlisten = await getCurrentWebviewWindow().listen<string>(
          event,
          (heard) => latest.current(heard.payload),
        );
        if (live) stop = unlisten;
        else unlisten();
      },
    );
    return () => {
      live = false;
      stop?.();
    };
  }, [event]);
}

/** The desktop draws no title bar: these elements move the window; buttons inside keep working. */
export const windowDragProps = () =>
  desktopConnection() ? ({ "data-tauri-drag-region": "deep" } as const) : {};

/** macOS keeps its native traffic lights at the top left, over the page, and hides them in fullscreen. */
export function useTrafficLightsInset() {
  const macos = desktopConnection()?.platform === "macos";
  const [fullscreen, setFullscreen] = useState(false);
  useEffect(() => {
    if (!macos) return;
    let live = true;
    let stop: (() => void) | undefined;
    void import("@tauri-apps/api/window").then(async ({ getCurrentWindow }) => {
      const view = getCurrentWindow();
      // The host reports the new state by the resize that ends each transition.
      const read = () =>
        view.isFullscreen().then(
          (value) => live && setFullscreen(value),
          () => {},
        );
      const unlisten = await view.onResized(read);
      if (!live) return unlisten();
      stop = unlisten;
      void read();
    });
    return () => {
      live = false;
      stop?.();
    };
  }, [macos]);
  return macos && !fullscreen;
}

/** Whether keys are a Mac's: ⌘ and ⌃, rather than Ctrl and Alt. */
export const macKeys = () => {
  const platform = desktopConnection()?.platform;
  return platform
    ? platform === "macos"
    : typeof navigator !== "undefined" &&
        /Mac|iPhone|iPad/.test(navigator.platform);
};

/** Windows and Linux have no native title bar in the desktop app: the page draws the buttons. */
export const drawsWindowControls = () => {
  const platform = desktopConnection()?.platform;
  return platform === "windows" || platform === "linux";
};

export type WindowControl = "minimize" | "toggle_maximize" | "close";

/** Acts on this window only; the desktop host refuses any other target. */
export async function windowControl(
  action: WindowControl,
): Promise<{ maximized: boolean }> {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<{ maximized: boolean }>("window_control", { action });
}

/** The host reads this before replacing a view, never to steer or resend a message. */
export function workspaceNavigationGuard(
  canLeave: () => boolean,
  leaveReason?: () => string | undefined,
) {
  if (!desktopConnection()) return () => {};
  const state = () => {
    const reason =
      navigationBlock() ??
      (canLeave()
        ? undefined
        : (leaveReason?.() ?? "Messages are waiting to be sent."));
    return { canLeave: !reason, reason, drafts: currentDrafts() };
  };
  window.zeroluxWorkspaceState = state;
  return () => {
    if (window.zeroluxWorkspaceState === state)
      delete window.zeroluxWorkspaceState;
  };
}

/** A ZeroLux the desktop app reaches, as its windows' switcher shows it. */
export interface DesktopWorkspace {
  profile: string;
  name: string;
  /** This window's own. */
  here: boolean;
  /** The computer whose kernel it is; none for this one. */
  computer: string | null;
  /** The requests waiting there. */
  requests: number;
}

/** Every ZeroLux the desktop app reaches, in their order, as they change. */
export function useDesktopWorkspaces() {
  const [workspaces, setWorkspaces] = useState<DesktopWorkspace[]>([]);
  const read = () =>
    void import("@tauri-apps/api/core")
      .then(({ invoke }) => invoke<DesktopWorkspace[]>("desktop_workspaces"))
      .then(setWorkspaces, () => {});
  useEffect(() => {
    if (desktopConnection()) read();
  }, []);
  useDesktopEvent("zerolux-workspaces", read);
  return workspaces;
}

/** Another ZeroLux the app reaches, instead of this window's, or in a window of its own. */
export async function desktopSwitch(profile: string, newWindow: boolean) {
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("desktop_switch", { profile, newWindow, path: null });
}

/** Another window of this window's ZeroLux, on a page of its own: `/w/<id>/`. */
export async function desktopNewWindow(path: string) {
  const profile = desktopConnection()?.profileId;
  if (!profile) return;
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("desktop_switch", { profile, newWindow: true, path });
}

/** An in-app navigation request opens the trusted manager; no data is returned to this page. */
export const WORKSPACES_LINK = "zerolux://workspaces";
