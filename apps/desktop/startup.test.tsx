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
  const capabilities = config.app.security.capabilities;
  expect(capabilities).toHaveLength(2);
  expect(capabilities[0].windows).toEqual(["manager"]);
  expect(capabilities[0].permissions).toEqual(["allow-workspace-action"]);
  expect(capabilities[0].remote).toBeUndefined();
  expect(capabilities[1].local).toBe(true);
  expect(capabilities[1].windows).toEqual(["workspace-*"]);
  expect(capabilities[1].permissions).toEqual([
    "allow-window-control",
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
  expect(capabilities[1].remote).toBeUndefined();
  expect(config.bundle.macOS.minimumSystemVersion).toBe("14.0");
});
