/** The tray's panel in the desktop app: what it asks of the app, and what the app tells it. */
declare global {
  interface Window {
    zeroluxTray?: Readonly<{ platform: "macos" | "windows" | "linux" }>;
  }
}

/** Whether this page is the tray's panel. */
export const trayPanel = () =>
  typeof window !== "undefined" ? window.zeroluxTray : undefined;

/** A workspace the panel hears: one opened since the app started. */
export interface TrayWorkspace {
  profile: string;
  workspace: string | null;
  name: string;
  kernel: string;
  active: boolean;
}

/** What the mark and Linux's menu show. */
export interface TrayReport {
  live: boolean;
  requests: {
    profile: string;
    id: string;
    title: string;
    choices: { id: string; label: string }[];
  }[];
  plans: string[];
}

const call = <T>(command: string, args: Record<string, unknown> = {}) =>
  import("@tauri-apps/api/core").then(({ invoke }) => invoke<T>(command, args));

export const trayWorkspaces = () => call<TrayWorkspace[]>("tray_workspaces");
export const trayCredential = (profile: string, workspace: string) =>
  call<string | null>("tray_credential", { profile, workspace });
export const trayReport = (report: TrayReport) =>
  call("tray_report", { report });
export const trayResize = (height: number) => call("tray_resize", { height });
export const trayHide = () => call("tray_hide");
/** A workspace in front, at one of its pages when it is named. */
export const trayOpen = (profile: string, path?: string) =>
  call("tray_open", { profile, path });

/** A new request, as a system notification answered from it. */
export const trayNotify = (ask: {
  profile: string;
  id: string;
  title: string;
  subtitle: string;
  body: string;
  choices: boolean;
}) => call("tray_notify", { ask });

/** A web address, in the system browser. */
export const trayLink = (url: string) => call("open_link", { url });

/** Another window of a workspace. */
export const trayNewWindow = (profile: string) =>
  call("tray_new_window", { profile });

/** What the app tells the panel: it opened, the workspaces changed, a menu answered. */
export function onTray<T>(
  event:
    | "zerolux-tray-shown"
    | "zerolux-tray-workspaces"
    | "zerolux-tray-choose"
    | "zerolux-tray-request",
  handler: (payload: T) => void,
) {
  let stop: (() => void) | undefined;
  let live = true;
  void import("@tauri-apps/api/webviewWindow").then(
    async ({ getCurrentWebviewWindow }) => {
      const unlisten = await getCurrentWebviewWindow().listen<T>(event, (e) =>
        handler(e.payload),
      );
      if (live) stop = unlisten;
      else unlisten();
    },
  );
  return () => {
    live = false;
    stop?.();
  };
}
