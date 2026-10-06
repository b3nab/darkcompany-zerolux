import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ByohPanel } from "./ByohPanel";
import { liveConnection, workerCommand } from "./api";
import type { Actor, AgentConnection, Workspace } from "./api";

const pi: Actor = {
  id: "pi-actor",
  name: "This pi",
  kind: "agent",
  owner_id: "owner",
  harness: "pi",
  created_at: 0,
  archived: false,
};
const connection: AgentConnection = {
  id: "connection",
  actor_id: pi.id,
  project_id: "project",
  mode: "pi_session",
  workspace: "/worktree",
  session_id: "session",
  connected_at: 1,
  lease_expires_at: 100,
  disconnected_at: null,
};

test("presence expires even before a reaper removes a connection", () => {
  expect(liveConnection([connection], pi.id, 50)).toEqual(connection);
  expect(liveConnection([connection], pi.id, 100)).toBeUndefined();
  expect(
    liveConnection([{ ...connection, disconnected_at: 5 }], pi.id, 50),
  ).toBeUndefined();
  expect(liveConnection([connection], "other", 50)).toBeUndefined();
});

test("worker instructions include the selected actor and explicit harness", () => {
  for (const harness of ["pi", "claude-code", "codex"] as const) {
    const command = workerCommand("project", { ...pi, harness });
    expect(command).toContain("--actor pi-actor");
    expect(command).toContain(`--harness ${harness}`);
    expect(command).not.toContain("resume");
  }
});

test("BYOH UI separates existing pi attachment from a fresh process", () => {
  const workspace: Workspace = {
    workspace: {
      id: "workspace",
      name: "Workspace",
      created_at: 0,
    },
    actors: [pi],
    projects: [],
    tasks: [],
    connections: [],
    onboarding_required: false,
  };
  const html = renderToStaticMarkup(
    <ByohPanel
      workspace={workspace}
      project={{
        id: "project",
        name: "ZeroLux",
        description: "",
        created_at: 1,
      }}
      agent={pi}
      hire={() => {}}
    />,
  );
  expect(html).toContain("/zerolux connect project pi-actor");
  expect(html).toContain("/zerolux take");
  expect(html).toContain("a fresh pi process");
  expect(html).toContain("Not connected");
  expect(html).toContain("No auto-start");
});
