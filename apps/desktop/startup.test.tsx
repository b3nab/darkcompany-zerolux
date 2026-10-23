import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { WorkspaceManager, newerDesktopState } from "./startup";
import type { DesktopState } from "./startup";

const state: DesktopState = {
  revision: 2,
  profiles: [
    {
      id: "profile-a",
      workspace_id: "workspace-a",
      name: "Studio",
      source: { kind: "existing", url: "https://studio.example/" },
      running: false,
    },
    {
      id: "profile-b",
      workspace_id: "workspace-b",
      name: "Local",
      source: { kind: "local", legacy: false },
      running: true,
    },
  ],
  active: "profile-a",
  computers: [],
  ready: true,
  busy: false,
  error: null,
};

test("a late initial list cannot replace a newer connection result", () => {
  const early = { ...state, revision: 1, ready: false, profiles: [] };
  expect(newerDesktopState(state, early)).toBe(state);
  expect(newerDesktopState(early, state)).toBe(state);
});

test("this computer joins a workspace with a code, and says how each joined one stands", () => {
  const html = renderToStaticMarkup(
    <WorkspaceManager
      initialState={{
        ...state,
        computers: [
          {
            id: "link-a",
            url: "http://192.0.2.10:4310",
            link: { state: "connected" },
            error: null,
          },
          {
            id: "link-b",
            url: "http://192.0.2.11:4310",
            link: null,
            error:
              "This computer was removed from the workspace; join it again with a new code",
          },
          {
            id: "link-c",
            url: "http://192.0.2.12:4310",
            link: { state: "reconnecting", error: "connection refused" },
            error: null,
          },
        ],
      }}
    />,
  );
  expect(html.match(/>Leave</g)).toHaveLength(3);
});

test("errors and names are text, and a failed setup does not present enabled actions", () => {
  const html = renderToStaticMarkup(
    <WorkspaceManager
      initialState={{
        ...state,
        ready: false,
        error: '<script>alert("wrong")</script>',
      }}
    />,
  );
  expect(html).toContain('role="alert"');
  expect(html).not.toContain("<script>");
  expect(html).toContain('disabled=""');
});

test("registry commands are restricted to the packaged manager, not workspace pages", async () => {
  const config = await Bun.file(
    new URL("./src-tauri/tauri.conf.json", import.meta.url),
  ).json();
  const capabilities = config.app.security.capabilities as {
    windows: string[];
    permissions: string[];
    local?: boolean;
    remote?: unknown;
  }[];
  const of = (window: string) =>
    capabilities.find((capability) => capability.windows.includes(window))!;
  expect(capabilities).toHaveLength(3);
  expect(
    capabilities.every((capability) => capability.windows.length === 1),
  ).toBe(true);
  expect(
    capabilities.every((capability) => capability.remote === undefined),
  ).toBe(true);
  expect(of("manager").permissions).toEqual(["allow-workspace-action"]);
  expect(of("workspace-*").local).toBe(true);
  expect(of("workspace-*").permissions).toEqual([
    "allow-window-control",
    // Web links only, to the system browser: extensions' pages open them too.
    "allow-open-link",
    // A folder chosen in the system's panel: only its path comes back.
    "allow-choose-folder",
    // Its own sign-in only: the desktop finds the connection from the calling window.
    "allow-read-workspace-credential",
    "allow-write-workspace-credential",
    "core:window:allow-start-dragging",
    "core:window:allow-internal-toggle-maximize",
    "core:window:allow-is-fullscreen",
    "core:event:allow-listen",
    "core:event:allow-unlisten",
    // The page's own notifications: shown and asked for, nothing else of the plugin.
    "notification:allow-is-permission-granted",
    "notification:allow-request-permission",
    "notification:allow-notify",
  ]);
  // The tray's panel hears every open workspace: their sign-ins are read, never written, and
  // it has no registry or window controls.
  expect(of("tray").local).toBe(true);
  expect(of("tray").permissions).toEqual([
    "allow-tray-workspaces",
    "allow-tray-credential",
    "allow-tray-report",
    "allow-tray-resize",
    "allow-tray-hide",
    "allow-tray-open",
    "allow-tray-new-window",
    "allow-tray-notify",
    "allow-open-link",
    "core:event:allow-listen",
    "core:event:allow-unlisten",
    "notification:allow-is-permission-granted",
    "notification:allow-request-permission",
    "notification:allow-notify",
  ]);
  expect(config.bundle.macOS.minimumSystemVersion).toBe("14.0");
});
