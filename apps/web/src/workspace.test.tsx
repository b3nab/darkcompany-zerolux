import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import type { Workspace } from "@zerolux/chat";
import { App } from "./App";
import { WorkspaceSettings } from "./components/workspace-settings";

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
      harness: null,
      archived: false,
      created_at,
    },
    {
      id: "aspen",
      name: "aspen",
      kind: "agent",
      owner_id: "owner",
      harness: "pi",
      archived: false,
      created_at,
    },
  ],
  projects: [],
  tasks: [],
  connections: [],
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
