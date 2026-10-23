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
  invited_by: null,
  harness: null,
  model: null,
  effort: null,
  permission_mode: null,
  approval_policy: null,
  sandbox: null,
  created_at: 0,
  archived: false,
};
const placeholder: Actor = {
  id: "local-agent",
  name: "Local agent",
  kind: "agent",
  owner_id: owner.id,
  invited_by: null,
  harness: null,
  model: null,
  effort: null,
  permission_mode: null,
  approval_policy: null,
  sandbox: null,
  created_at: 0,
  archived: true,
};
const pi: Actor = {
  id: "pi-actor",
  name: "My pi",
  kind: "agent",
  owner_id: owner.id,
  invited_by: null,
  harness: "pi",
  model: null,
  effort: null,
  permission_mode: null,
  approval_policy: null,
  sandbox: null,
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

test("first-run UI requires a blank, named input before agent hiring", () => {
  const html = at("/", <App initialWorkspace={initial} />);
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
    "/team",
    <App
      initialWorkspace={{
        ...initial,
        onboarding_required: false,
        actors: [{ ...owner, name: "Ada Lovelace" }],
      }}
    />,
  );
  expect(html).toContain("Ada Lovelace");
  expect(html).toContain("Your agents.");
  expect(html).toContain("Hire an agent");
  expect(html).not.toContain("Local owner");
  expect(html).not.toContain("Local agent");
  expect(html).not.toContain("/zerolux connect");
  expect(html).not.toContain("Create draft");
});

test("retired agents are absent from the roster", () => {
  expect(activeActors([owner, placeholder, pi])).toEqual([owner, pi]);
  const html = at(
    "/team",
    <App
      initialWorkspace={{
        ...initial,
        onboarding_required: false,
        actors: [{ ...owner, name: "Ada" }, placeholder, pi],
      }}
    />,
  );
  expect(html).not.toContain("Local agent");
  expect(html).toContain("My pi");
  expect(html).not.toContain("Create draft");
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
});

test("onboarding saving state disables duplicate submissions", () => {
  const html = renderToStaticMarkup(
    <OwnerOnboarding busy save={async () => true} />,
  );
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
  expect(at("/team", app)).toContain("Your agents.");
  // An agent that is not (or no longer) on the team goes back to the team.
  expect(at("/team/unknown", app)).toContain("Your agents.");
  expect(at("/team/hire", app)).toContain("Team / Hire");
  expect(at("/chats", app)).toMatch(
    /<a[^>]*aria-label="New chat"[^>]*href="\/chats\/new"/,
  );
  const home = at("/", app);
  for (const page of ["/chats", "/team", "/org", "/meetings", "/approvals"])
    expect(home).toContain(`href="${page}"`);
  expect(home).not.toContain('href="/projects');
  expect(home).not.toContain("Create project");
  expect(home).not.toContain("worker");
  // Team's panel lists your agents, and hires one.
  const team = at("/team", app);
  expect(team).toContain(">Your agents</h2>");
  expect(team).toMatch(
    /<a[^>]*aria-label="Hire an agent"[^>]*href="\/team\/hire"/,
  );
});

test("a kernel without chat-v1 does not fall back to removed project controls", () => {
  const workspace = {
    ...initial,
    onboarding_required: false,
    actors: [{ ...owner, name: "Ada" }],
  };
  const older = at(
    "/",
    <App
      initialWorkspace={workspace}
      initialHealth={{
        version: "0.1.0",
        capabilities: ["owner-onboarding-v1"],
      }}
    />,
  );
  expect(older).not.toContain(">Chats<");
  expect(older).not.toContain("Talk with your agents.");
  expect(older).not.toContain('aria-label="Hire an agent"');
  expect(older).toContain("Update the kernel to use chats.");
  expect(older).not.toContain("Create draft");
  // The kernel's version is in the window's status bar.
  expect(older).toMatch(
    /<footer role="status"[\s\S]*0\.1\.0<\/span><\/footer>/,
  );
  const current = at(
    "/chats",
    <App
      initialWorkspace={workspace}
      initialHealth={{
        version: "0.0.1-dev",
        capabilities: ["owner-onboarding-v1", "chat-v1", "auth-v1"],
      }}
    />,
  );
  // The kernel's version, in the window's status bar.
  expect(current).toMatch(/<footer role="status"[\s\S]*v0\.0\.1-dev/);
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
});
