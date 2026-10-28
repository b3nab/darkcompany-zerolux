import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import type { Workspace } from "@zerolux/chat";
import { App } from "./App";
import { AdministrationPage, MySettingsPage, ProfilePage } from "./Account";
import { Connection, WorkspaceSettings } from "./components/workspace-settings";

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

test("workspace settings edit only the name and keep creation metadata read-only", () => {
  const html = renderToStaticMarkup(
    <WorkspaceSettings
      workspace={company.workspace}
      busy={false}
      error=""
      save={async () => {}}
    />,
  );
  expect(html).toContain('value="Research studio"');
  expect(html).toContain('name="name"');
  expect(html).not.toContain('name="created_at"');
});

test("the desktop's connection is this device's, apart from the workspace's shared name", () => {
  const html = renderToStaticMarkup(
    <Connection
      connection={{ address: "https://studio.example", desktop: true }}
    />,
  );
  expect(html).toContain('value="https://studio.example"');
  expect(html).toContain('href="zerolux://workspaces"');
  expect(html).not.toContain('name="address"');
  const browser = renderToStaticMarkup(
    <Connection
      connection={{ address: "https://studio.example", desktop: false }}
    />,
  );
  expect(browser).not.toContain('href="zerolux://workspaces"');
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
  expect(profile).toContain(owner.name);

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
  expect(mine).toContain('role="radiogroup"');
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
  expect(admin).toContain("0.0.1-dev");
});
