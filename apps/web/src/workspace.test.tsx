import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import type { Workspace } from "@zerolux/chat";
import { App } from "./App";
import {
  AdministrationPage,
  hostState,
  MySettingsPage,
  ProfilePage,
} from "./Account";
import {
  Connection,
  WorkspaceSettings,
  connectionKind,
} from "./components/workspace-settings";

test("address locality stays separate from ownership and connection status", () => {
  expect(connectionKind("http://127.0.0.1:4310", true)).toBe(
    "Managed on this device",
  );
  expect(connectionKind("http://127.0.0.1:4310")).toBe(
    "Local address · existing kernel",
  );
  expect(connectionKind("http://[::1]:4310")).toBe(
    "Local address · existing kernel",
  );
  expect(connectionKind("https://office.example")).toBe(
    "Network address · existing kernel",
  );
});

const created_at = Date.UTC(2026, 0, 2, 12);
const company: Workspace = {
  workspace: {
    id: "workspace",
    name: "Research studio",
    created_at,
  },
  actors: [
    {
      id: "owner",
      name: "Owner",
      kind: "human",
      owner_id: null,
      invited_by: null,
      harness: null,
      model: null,
      effort: null,
      permission_mode: null,
      approval_policy: null,
      sandbox: null,
      archived: false,
      created_at,
    },
    {
      id: "aspen",
      name: "aspen",
      kind: "agent",
      owner_id: "owner",
      invited_by: null,
      harness: "pi",
      model: null,
      effort: null,
      permission_mode: null,
      approval_policy: null,
      sandbox: null,
      archived: false,
      created_at,
    },
  ],
  onboarding_required: false,
};
const render = (workspace: Workspace, actor = "owner") =>
  renderToStaticMarkup(
    <MemoryRouter initialEntries={[`/org?actor=${actor}`]}>
      <App initialWorkspace={workspace} />
    </MemoryRouter>,
  );

test("the shell uses the persistent workspace name and shows creation dates for people and agents", () => {
  const owner = render(company);
  expect(owner).toContain("Research studio");
  expect(owner).toMatch(/Day \d+ · 2 members/);
  expect(owner).toContain("Created 2026-01-02");
  const agent = render(company, "aspen");
  expect(agent).toContain("Created 2026-01-02");
});

test("a future workspace timestamp does not produce a negative company day", () => {
  const html = render({
    ...company,
    workspace: { ...company.workspace, created_at: Date.UTC(9999, 0, 1) },
  });
  expect(html).toContain("Created 9999-01-01 · 2 members");
  expect(html).not.toMatch(/Day -?\d+ ·/);
});

test("workspace settings edit only the name and keep creation metadata read-only", () => {
  const html = renderToStaticMarkup(
    <WorkspaceSettings
      workspace={company.workspace}
      busy={false}
      error=""
      save={async () => {}}
    />,
  );
  expect(html).toContain('aria-label="Workspace settings"');
  expect(html).toContain('value="Research studio"');
  expect(html).toContain('name="name"');
  expect(html).toContain("Created 2026-01-02");
  expect(html).not.toContain('name="created_at"');
  expect(html).toContain("Save name");
});

test("the desktop's connection is this device's, apart from the workspace's shared name", () => {
  const html = renderToStaticMarkup(
    <Connection
      connection={{ address: "https://studio.example", desktop: true }}
    />,
  );
  expect(html).not.toContain("Workspace name");
  expect(html).toContain('value="https://studio.example"');
  expect(html).toContain('href="zerolux://workspaces"');
  expect(html).toContain("Manage connections");
  expect(html).not.toContain('name="address"');
  const browser = renderToStaticMarkup(
    <Connection
      connection={{ address: "https://studio.example", desktop: false }}
    />,
  );
  expect(browser).not.toContain('href="zerolux://workspaces"');
  expect(browser).toContain("This browser connects");
});

test("workspace settings expose server errors and disable editing during a save", () => {
  const html = renderToStaticMarkup(
    <WorkspaceSettings
      workspace={company.workspace}
      busy
      error="The kernel is unavailable"
      save={async () => {}}
    />,
  );
  expect(html).toContain('role="alert"');
  expect(html).toContain("The kernel is unavailable");
  expect(html).toContain("Saving…");
  expect(html).toMatch(/<input\b[^>]*\sdisabled=""/);
  expect(html).toMatch(/<button\b[^>]*\sdisabled=""/);
});

test("your profile, your settings and the administration are three separate pages", () => {
  const owner = company.actors.find((actor) => actor.kind === "human")!;
  const profile = renderToStaticMarkup(
    <MemoryRouter>
      <ProfilePage owner={owner} />
    </MemoryRouter>,
  );
  expect(profile).toContain("Your profile");
  expect(profile).toContain(owner.name);
  expect(profile).not.toContain("Workspace name");

  const mine = renderToStaticMarkup(
    <MemoryRouter>
      <MySettingsPage
        me={owner}
        actors={company.actors}
        busy={false}
        perform={async () => true}
      />
    </MemoryRouter>,
  );
  for (const part of ["Notifications", "This device", "Theme", "Light"])
    expect(mine).toContain(part);
  expect(mine).toContain('role="radiogroup"');
  expect(mine).not.toContain("Workspace name");
  // Notifications on this device: asked for first, then chosen by kind.
  expect(mine).toContain("This browser cannot show notifications.");
  const settings = (permission: NotificationPermission) => {
    globalThis.Notification = { permission } as typeof Notification;
    try {
      return renderToStaticMarkup(
        <MemoryRouter>
          <MySettingsPage
            me={owner}
            actors={company.actors}
            busy={false}
            perform={async () => true}
          />
        </MemoryRouter>,
      );
    } finally {
      delete (globalThis as { Notification?: unknown }).Notification;
    }
  };
  expect(settings("default")).toContain("Allow notifications");
  expect(settings("denied")).toContain("blocked for this page");
  const granted = settings("granted");
  expect(granted).toContain("When a session needs you");
  expect(granted).toContain("When a session finishes its work");

  const admin = renderToStaticMarkup(
    <MemoryRouter>
      <AdministrationPage
        workspace={company}
        busy={false}
        perform={async () => true}
        kernel={{ version: "0.0.1-dev", capabilities: ["chat-v1"] }}
      />
    </MemoryRouter>,
  );
  for (const part of [
    "Workspace name",
    "People",
    "Agents",
    "Modules",
    "Storage and updates",
    "Features",
    "0.0.1-dev",
  ])
    expect(admin).toContain(part);
  // Chats are on in this kernel, meetings are not yet.
  expect(admin).toMatch(/Chats<\/span>(?:(?!<\/li>).)*Available/);
  expect(admin).toMatch(/Meetings<\/span>(?:(?!<\/li>).)*Not yet/);
  expect(admin).not.toContain("Theme");
});

test("a computer says where it stands: the kernel's own, waiting for its code, online or not", () => {
  const host = {
    id: "h1",
    name: "Studio Mac",
    person_id: "p1",
    open: false,
    created_at: 0,
    seen_at: Date.now(),
    here: false,
    joined: true,
    online: true,
  };
  expect(hostState(host)).toBe("online");
  expect(hostState({ ...host, online: false })).toMatch(/^offline · seen /);
  expect(hostState({ ...host, joined: false, online: false })).toBe(
    "waiting to join",
  );
  expect(hostState({ ...host, here: true })).toMatch(/^runs ZeroLux · seen /);
});
