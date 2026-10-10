import { expect, test } from "bun:test";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { App } from "./App";
import { OwnerOnboarding, ownerNameError } from "./OwnerOnboarding";
import { activeActors } from "./api";
import type { Actor, Workspace } from "./api";

/** Renders the app as it looks at an address. */
const at = (path: string, app: ReactNode) =>
  renderToStaticMarkup(
    <MemoryRouter initialEntries={[path]}>{app}</MemoryRouter>,
  );

const owner: Actor = {
  id: "6508aada-96ec-491d-b6ec-6c43a3ad6235",
  name: "Local owner",
  kind: "human",
  owner_id: null,
  harness: null,
  created_at: 0,
  archived: false,
};
const placeholder: Actor = {
  id: "local-agent",
  name: "Local agent",
  kind: "agent",
  owner_id: owner.id,
  harness: null,
  created_at: 0,
  archived: true,
};
const pi: Actor = {
  id: "pi-actor",
  name: "My pi",
  kind: "agent",
  owner_id: owner.id,
  harness: "pi",
  created_at: 0,
  archived: false,
};
const initial: Workspace = {
  workspace: {
    id: "workspace",
    name: "Workspace",
    created_at: 0,
  },
  actors: [owner],
  projects: [],
  tasks: [],
  connections: [],
  onboarding_required: true,
};

test("name validation rejects empty/default/control/overlong values without excluding international names", () => {
  for (const name of [
    "",
    "  ",
    "\t\n\u2003",
    "Local owner",
    " LOCAL OWNER ",
    "Ada\nInjected",
    "x".repeat(201),
    "😀".repeat(51),
  ]) {
    expect(ownerNameError(name)).toBeString();
  }
  for (const name of [
    "Ada",
    " Élodie 李 ",
    "O'Connor",
    "李",
    "x".repeat(200),
    "😀".repeat(50),
  ])
    expect(ownerNameError(name)).toBeUndefined();
});

test("first-run UI requires a blank, named input before exposing project creation or agent hiring", () => {
  const html = at("/", <App initialWorkspace={initial} />);
  expect(html).toContain("First, what should we call you?");
  expect(html).toContain('autoComplete="name"');
  expect(html).toContain('name="name"');
  expect(html).toContain('value=""');
  expect(html).toContain("Save name &amp; continue");
  expect(html).toContain("disabled");
  expect(html).not.toContain("Local owner");
  expect(html).not.toContain("Local agent");
  expect(html).not.toContain("Hire agent");
  expect(html).not.toContain("Create project");
});

test("saving the owner name reveals an empty team, not an implicitly selected placeholder", () => {
  const html = at(
    "/projects/project",
    <App
      initialWorkspace={{
        ...initial,
        onboarding_required: false,
        actors: [{ ...owner, name: "Ada Lovelace" }],
        projects: [
          { id: "project", name: "ZeroLux", description: "", created_at: 1 },
        ],
      }}
    />,
  );
  expect(html).toContain("Ada Lovelace");
  expect(html).toContain("No agents yet");
  expect(html).toContain("Hire an agent first");
  expect(html).not.toContain("Local owner");
  expect(html).not.toContain("Local agent");
  expect(html).not.toContain("/zerolux connect");
  expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Create draft<\/button>/);
});

test("retired agents are absent from the roster and assignment options; legacy tasks can be recovered explicitly", () => {
  expect(activeActors([owner, placeholder, pi])).toEqual([owner, pi]);
  const html = at(
    "/projects/project",
    <App
      initialWorkspace={{
        ...initial,
        onboarding_required: false,
        actors: [{ ...owner, name: "Ada" }, placeholder, pi],
        projects: [
          { id: "project", name: "ZeroLux", description: "", created_at: 1 },
        ],
        tasks: [
          {
            id: "legacy",
            project_id: "project",
            title: "Preserved task",
            description: "",
            assignee_id: placeholder.id,
            status: "queued",
            review_note: "",
            created_at: 1,
            updated_at: 1,
          },
        ],
      }}
    />,
  );
  expect(html).not.toContain("Local agent");
  expect(html).not.toContain('value="local-agent"');
  expect(html).toContain("Preserved task");
  expect(html).toContain("Retired agent");
  expect(html).toContain("Assign &amp; return to draft");
  expect(html).toContain("owned by Ada");
});

test("desktop welcome can return to workspaces without completing onboarding, even while saving", () => {
  for (const busy of [false, true]) {
    const html = renderToStaticMarkup(
      <OwnerOnboarding desktop busy={busy} save={async () => true} />,
    );
    expect(html).toMatch(
      /<a[^>]*href="zerolux:\/\/workspaces"[^>]*>Back to workspaces<\/a>/,
    );
    expect(html.indexOf("Back to workspaces")).toBeLessThan(
      html.indexOf("<form"),
    );
  }
  const browser = renderToStaticMarkup(
    <OwnerOnboarding desktop={false} busy={false} save={async () => true} />,
  );
  expect(browser).not.toContain("zerolux://workspaces");
});

test("onboarding saving state disables duplicate submissions", () => {
  const html = renderToStaticMarkup(
    <OwnerOnboarding busy save={async () => true} />,
  );
  expect(html).toContain("Saving…");
  expect(html).toMatch(/<input[^>]*disabled=""/);
});

test("after onboarding the chats page shows the steps to a first chat", () => {
  const html = at(
    "/chats",
    <App
      initialWorkspace={{
        ...initial,
        onboarding_required: false,
        actors: [{ ...owner, name: "Ada" }],
      }}
    />,
  );
  expect(html).toContain("Talk with your agents.");
  expect(html).toContain("Hire your agents");
  // The next step is the main action.
  expect(html).toMatch(
    /<button[^>]*class="[^"]*\bbg-primary\b[^"]*"[^>]*>Hire an agent<\/button>/,
  );
  expect(html).toMatch(/<button[^>]*disabled=""[^>]*>New chat<\/button>/);
  expect(html).not.toContain("BYOH / task workers");
  expect(html).not.toContain("cargo run -- worker");
});

test("every page has its own address, and the bar links to them", () => {
  const app = (
    <App
      initialWorkspace={{
        ...initial,
        onboarding_required: false,
        actors: [{ ...owner, name: "Ada" }],
      }}
    />
  );
  expect(at("/team", app)).toContain("Team / Your agents");
  expect(at("/team/hire", app)).toContain("Team / Hire");
  expect(at("/chats/new", app)).toContain("Hire an agent to start chatting.");
  // A chat that is not (yet) in the list shows the chats home.
  expect(at("/chats/unknown", app)).toContain("Talk with your agents.");
  expect(at("/chats", app)).toMatch(
    /<a[^>]*aria-label="New chat"[^>]*href="\/chats\/new"/,
  );
  const home = at("/", app);
  for (const page of [
    "/chats",
    "/projects",
    "/team",
    "/org",
    "/meetings",
    "/storage",
    "/approvals",
  ])
    expect(home).toContain(`href="${page}"`);
  // Team's panel lists your agents, and hires one.
  const team = at("/team", app);
  expect(team).toContain(">Your agents</h2>");
  expect(team).toMatch(
    /<a[^>]*aria-label="Hire an agent"[^>]*href="\/team\/hire"/,
  );
});

test("an older kernel without chat-v1 gets the project view and no chat controls", () => {
  const workspace = {
    ...initial,
    onboarding_required: false,
    actors: [{ ...owner, name: "Ada" }],
    projects: [
      { id: "project", name: "ZeroLux", description: "", created_at: 1 },
    ],
  };
  const older = at(
    "/",
    <App
      initialWorkspace={workspace}
      initialHealth={{
        version: "0.1.0",
        capabilities: ["byoh-v1", "owner-onboarding-v1"],
      }}
    />,
  );
  expect(older).not.toContain(">Chats<");
  expect(older).not.toContain("Talk with your agents.");
  expect(older).not.toContain('aria-label="Hire an agent"');
  expect(older).toContain("Create draft");
  expect(older).toContain("v0.1.0");
  const current = at(
    "/chats",
    <App
      initialWorkspace={workspace}
      initialHealth={{
        version: "0.0.1-dev",
        capabilities: ["byoh-v1", "owner-onboarding-v1", "chat-v1"],
      }}
    />,
  );
  expect(current).toContain("Talk with your agents.");
  // The kernel's version, in the rail.
  expect(current).toContain("v0.0.1-dev");
});

/** The labels of the buttons that send a form; Base UI buttons default to type="button". */
const submits = (html: string) =>
  [...html.matchAll(/<button[^>]*type="submit"[^>]*>([^<]*)</g)].map(
    (m) => m[1],
  );

test("forms are sent by their own submit button", () => {
  expect(
    submits(
      renderToStaticMarkup(
        <OwnerOnboarding busy={false} save={async () => true} />,
      ),
    ),
  ).toEqual(["Save name &amp; continue"]);
  // With no project yet, the Projects panel offers the project form.
  const projects = at(
    "/projects",
    <App
      initialWorkspace={{
        ...initial,
        onboarding_required: false,
        actors: [{ ...owner, name: "Ada" }],
      }}
    />,
  );
  expect(submits(projects)).toEqual(["Create project"]);
  const project = at(
    "/projects/project",
    <App
      initialWorkspace={{
        ...initial,
        onboarding_required: false,
        actors: [{ ...owner, name: "Ada" }, pi],
        projects: [
          { id: "project", name: "ZeroLux", description: "", created_at: 1 },
        ],
      }}
    />,
  );
  expect(submits(project)).toEqual(["Create draft"]);
});
