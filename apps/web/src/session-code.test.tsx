import { afterEach, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { setKernelFetch, useSessionGit } from "@zerolux/chat";
import type { ChatSession, GitStatus } from "@zerolux/chat";
import { ChangesPanel } from "./SessionCode";

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
