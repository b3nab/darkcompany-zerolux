import { afterEach, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { setKernelFetch, useSessionGit } from "@zerolux/chat";
import type { ChatSession, GitStatus } from "@zerolux/chat";
import { ChangesPanel, FilesPanel } from "./SessionCode";
import { InputActions } from "./SessionFork";
import { ScheduleForm } from "./SessionSchedules";
import { GoalCard } from "./SessionGoal";
import { TriggerForm } from "./SessionTriggers";
import { SubagentList } from "./SessionSubagents";
import { SubagentCard } from "@/components/tool-call";
import { Marked } from "./Console";
import { SessionBlocks } from "@/components/session-blocks";
import type { InputBlock } from "@/components/session-blocks";

afterEach(() => setKernelFetch());

const session = {
  id: "s-aspen",
  harness: "claude-code",
  workspace: "/home/owner/github/zerolux",
  status: "connected",
} as ChatSession;

const status: GitStatus = {
  branch: "main",
  upstream: null,
  ahead: 0,
  behind: 0,
  changes: [
    { path: "src/app.ts", from: null, staged: "M", unstaged: "." },
    { path: "docs/notes.md", from: null, staged: ".", unstaged: "M" },
    { path: "new.md", from: null, staged: ".", unstaged: "?" },
  ],
};

const nothing = async () => {};
const panel = (shown: GitStatus) =>
  renderToStaticMarkup(
    <ChangesPanel
      session={session}
      name="aspen"
      git={{
        status: shown,
        error: "",
        reload: nothing,
        stage: nothing,
        unstage: nothing,
        discard: nothing,
        commit: async () => "abc",
        push: nothing,
      }}
      revision={0}
      busy={false}
      perform={async () => true}
      send={nothing}
      close={() => {}}
    />,
  );

test("the Changes panel shows what is staged and what is not, the commit and the push", () => {
  const html = panel(status);
  // A file's name first, then its folder.
  expect(html).toContain(">app.ts<");
  expect(html).toContain(">src<");
});

test("the owner's git actions go to the session's folder", async () => {
  const requests: [string, unknown][] = [];
  setKernelFetch(async (url, init = {}) => {
    requests.push([
      String(url),
      init.body ? JSON.parse(init.body as string) : undefined,
    ]);
    return Response.json(
      String(url).endsWith("/commit") ? { commit: "abc" } : status,
    );
  });
  let git: ReturnType<typeof useSessionGit> | undefined;
  function Probe() {
    git = useSessionGit("s/1", 0, "https://fixture.example.test");
    return null;
  }
  renderToStaticMarkup(<Probe />);
  await git!.stage(["a.md", "b.md"]);
  await git!.discard(["new.md"]);
  expect(await git!.commit("Fix the build")).toBe("abc");
  await git!.push();
  const base = "https://fixture.example.test/api/sessions/s%2F1/git";
  expect(requests).toEqual([
    [`${base}/stage`, { paths: ["a.md", "b.md"] }],
    [`${base}/discard`, { paths: ["new.md"] }],
    [`${base}/commit`, { message: "Fix the build" }],
    [base, undefined],
    [`${base}/push`, {}],
  ]);
});

test("a schedule is written as a rule, and says in words when it runs", () => {
  const form = (rule: Parameters<typeof ScheduleForm>[0]["initial"]["rule"]) =>
    renderToStaticMarkup(
      <ScheduleForm
        initial={{ rule, prompt: "Check the build" }}
        busy={false}
        save={() => {}}
        cancel={() => {}}
      />,
    );
  const weekday = form({ every: "weekday", hour: 9, minute: 0 });
  expect(weekday).toContain('value="09:00"');
  expect(weekday).toContain(">Check the build</textarea>");
  const custom = form({ every: "custom", cron: "*/15 * * * *" });
});

test("a search's words stand out in what matched, and each step names where it is", () => {
  const html = renderToStaticMarkup(
    <Marked text="Fixed the build, then the BUILD docs" query="build" />,
  );
  expect(html.match(/<mark/g)).toHaveLength(2);
  expect(html).toContain(">BUILD</mark>");
  // Special characters are searched as written.
  expect(renderToStaticMarkup(<Marked text="a (b) c" query="(b)" />)).toContain(
    ">(b)</mark>",
  );
  const blocks = renderToStaticMarkup(
    <SessionBlocks
      blocks={[{ key: "4096.0", time: null, kind: "text", text: "Done." }]}
    />,
  );
  expect(blocks).toContain('data-at="4096"');
});

test("the agent's words carry what can be done with them, such as hearing them", () => {
  const html = renderToStaticMarkup(
    <SessionBlocks
      blocks={[
        { key: "8.0", time: null, kind: "text", text: "Ready for review." },
        { key: "9.0", time: null, kind: "thinking", text: "Checking" },
      ]}
      textActions={(text) => <button>{`Listen to ${text.key}`}</button>}
    />,
  );
  // Only the words, never the reasoning.
  expect(html.match(/Listen to/g)).toHaveLength(1);
});

test("every message of a session says when it was written, and words given or said can be copied", () => {
  const time = "2026-10-30T09:05:00.000Z";
  const html = renderToStaticMarkup(
    <SessionBlocks
      blocks={[
        { key: "1.0", time, kind: "input", text: "Check", chat: null, at: 1 },
        { key: "2.0", time, kind: "text", text: "Checked." },
        { key: "3.0", time, kind: "notice", text: "Agent done" },
        { key: "4.0", time: null, kind: "text", text: "Unrecorded." },
      ]}
    />,
  );
  expect(
    html.match(new RegExp(`<time[^>]*dateTime="${time}"`, "g")),
  ).toHaveLength(3);
  // A copy for each input and each of the agent's words; none for a notice.
  expect(html.match(/<button/g)).toHaveLength(3);
});

test("a session listens for its CI: failures only by default, then the owner's words", () => {
  const form = (failures_only: boolean) =>
    renderToStaticMarkup(
      <TriggerForm
        initial={{ failures_only, prompt: "Fix what failed." }}
        busy={false}
        save={() => {}}
        cancel={() => {}}
      />,
    );
  expect(form(true)).toContain(">Fix what failed.</textarea>");
});
