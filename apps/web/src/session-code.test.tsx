import { afterEach, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { setKernelFetch, useSessionGit } from "@zerolux/chat";
import type { ChatSession, GitStatus } from "@zerolux/chat";
import { ChangesPanel, FilesPanel } from "./SessionCode";
import { InputActions } from "./SessionFork";
import { ScheduleForm } from "./SessionSchedules";
import { GoalCard } from "./SessionGoal";
import { TriggerForm } from "./SessionTriggers";
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
  expect(html).toContain("Staged · 1");
  expect(html).toContain("Changes · 2");
  // A file's name first, then its folder.
  expect(html).toContain(">app.ts<");
  expect(html).toContain(">src<");
  expect(html).toContain('aria-label="Stage new.md"');
  expect(html).toContain('aria-label="Unstage src/app.ts"');
  expect(html).toContain("Commit 1 file");
  // A branch on no remote is published; one ahead is pushed.
  expect(html).toContain("Publish branch");
  const pushed = panel({
    ...status,
    upstream: "origin/main",
    ahead: 2,
    changes: [],
  });
  expect(pushed).toContain("Push 2 commits");
  expect(pushed).toContain("Nothing changed since the last commit.");
  expect(pushed).not.toContain("Commit message");
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

test("an input is written again in a fork, and its files put back only where the harness keeps checkpoints", () => {
  const input: InputBlock = {
    key: "1.0",
    time: null,
    kind: "input",
    text: "Fix the build",
    chat: null,
    at: 42,
  };
  const actions = (rewind?: boolean) =>
    renderToStaticMarkup(
      <InputActions
        input={input}
        fork={async () => true}
        rewind={
          rewind
            ? async () => ({ canRewind: true, filesChanged: ["a.md"] })
            : undefined
        }
        busy={false}
        perform={async () => true}
      />,
    );
  expect(actions()).toContain("Edit");
  expect(actions()).not.toContain("Rewind files");
  expect(actions(true)).toContain("Rewind files");
});

test("the Files panel finds a session's files by what is typed", () => {
  const html = renderToStaticMarkup(
    <FilesPanel
      session={session}
      name="aspen"
      revision={0}
      busy={false}
      perform={async () => true}
      send={nothing}
      close={() => {}}
    />,
  );
  expect(html).toContain('aria-label="Find a file"');
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
  expect(weekday).toContain("Every weekday at 09:00");
  expect(weekday).toContain('value="09:00"');
  expect(weekday).toContain(">Check the build</textarea>");
  expect(form({ every: "week", day: 1, hour: 18, minute: 30 })).toContain(
    "Every Monday at 18:30",
  );
  const custom = form({ every: "custom", cron: "*/15 * * * *" });
  expect(custom).toContain('aria-label="Cron pattern"');
  expect(custom).toContain("*/15 * * * *, in the time");
});

test("a Codex session's goal is set by whoever may write to it", () => {
  const card = (write: boolean) =>
    renderToStaticMarkup(
      <GoalCard
        session={{ ...session, harness: "codex" }}
        read={async () => ({ seq: 0, items: [] })}
        write={write}
        busy={false}
        perform={async () => true}
      />,
    );
  expect(card(true)).toContain("No goal.");
  expect(card(true)).toContain("Set a goal");
  expect(card(false)).not.toContain("Set a goal");
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
  expect(form(true)).toContain("hears of a failure");
  expect(form(true)).toContain(">Fix what failed.</textarea>");
  expect(form(false)).toContain("hears how they went");
});
