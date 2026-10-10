import { currentDrafts } from "@zerolux/chat";

/** Optional desktop context. No native API or other workspace's configuration is exposed. */
declare global {
  interface Window {
    zeroluxDesktop?: Readonly<{
      profileId: string;
      workspaceId: string;
      managed?: boolean;
      kernelUrl?: string;
      platform?: "macos" | "windows" | "linux";
    }>;
    zeroluxWorkspaceState?: () => {
      canLeave: boolean;
      drafts: Record<string, string>;
    };
    zeroluxRestoredDrafts?: Record<string, string>;
  }
}

export function desktopConnection() {
  return typeof window !== "undefined" ? window.zeroluxDesktop : undefined;
}

/** Where this page's kernel is: the desktop names it, a browser uses the page's own origin. */
export const kernelAddress = () => desktopConnection()?.kernelUrl ?? "";

/** The desktop draws no title bar: these elements move the window; buttons inside keep working. */
export const windowDragProps = () =>
  desktopConnection() ? ({ "data-tauri-drag-region": "deep" } as const) : {};

/** macOS keeps its native traffic lights at the top left, over the page. */
export const trafficLightsInset = () =>
  desktopConnection()?.platform === "macos";

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
export function workspaceNavigationGuard(canLeave: () => boolean) {
  if (!desktopConnection()) return () => {};
  const state = () => ({ canLeave: canLeave(), drafts: currentDrafts() });
  window.zeroluxWorkspaceState = state;
  return () => {
    if (window.zeroluxWorkspaceState === state)
      delete window.zeroluxWorkspaceState;
  };
}

/** An in-app navigation request opens the trusted manager; no data is returned to this page. */
export const WORKSPACES_LINK = "zerolux://workspaces";
