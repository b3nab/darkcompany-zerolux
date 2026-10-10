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
  ready: true,
  busy: false,
  error: null,
};

test("a late initial list cannot replace a newer connection result", () => {
  const early = { ...state, revision: 1, ready: false, profiles: [] };
  expect(newerDesktopState(state, early)).toBe(state);
  expect(newerDesktopState(early, state)).toBe(state);
});

test("the manager distinguishes saved connections from local kernel ownership", () => {
  const html = renderToStaticMarkup(<WorkspaceManager initialState={state} />);
  expect(html).toContain("https://studio.example/");
  expect(html).toContain("workspace-a");
  expect(html).toContain("Managed on this device · running");
  expect(html).toContain("Return");
  expect(html).toContain("Change address");
  expect(html).toContain("Connect an existing workspace");
  expect(html).toContain("Create a local workspace");
  expect(html).toContain(
    "A running local kernel keeps its connection in this list",
  );
  expect(html).toContain(
    "Quitting only shuts down local kernels started by this app",
  );
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
  expect(html).toContain("&lt;script&gt;");
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
  ]);
  expect(capabilities[1].remote).toBeUndefined();
  expect(config.bundle.macOS.minimumSystemVersion).toBe("14.0");
});
