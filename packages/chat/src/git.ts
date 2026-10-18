import { useCallback, useEffect, useState } from "react";
import { errorMessage, kernelUrl, request } from "./client";
import type { DiffLine } from "./tool-view";

/**
 * A changed path, with git's letters for the index (`staged`) and the working tree
 * (`unstaged`): M, A, D, R, C, T or U; `?` untracked; `.` nothing.
 */
export interface GitChange {
  path: string;
  /** Where a renamed or copied file came from. */
  from: string | null;
  staged: string;
  unstaged: string;
}

/** What git sees in a session's folder. */
export interface GitStatus {
  /** The branch checked out; null when HEAD is detached. */
  branch: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
  changes: GitChange[];
}

/** What git's letters say, in words. */
export const changeLabels: Record<string, string> = {
  M: "Modified",
  A: "Added",
  D: "Deleted",
  R: "Renamed",
  C: "Copied",
  T: "Type changed",
  U: "Conflict",
  "?": "Untracked",
};

/** A change with something staged for the next commit. */
export const isStaged = (change: GitChange) => change.staged !== ".";
/** A change with something not staged yet, an untracked file included. */
export const isUnstaged = (change: GitChange) => change.unstaged !== ".";

/**
 * A line of git's diff: a hunk's header, or a line kept, added or removed (as a tool's
 * `DiffLine`), with its numbers.
 */
export interface GitDiffLine {
  kind: "hunk" | DiffLine["kind"];
  text: string;
  /** Its number in the file before. */
  old?: number;
  /** Its number in the file after. */
  new?: number;
}

/** A file's unified diff as lines, with how many were added and removed. */
export interface GitDiff {
  lines: GitDiffLine[];
  added: number;
  removed: number;
  /** Git shows no lines for a binary file. */
  binary: boolean;
}

/** The lines of a file's unified diff, numbered as in the files before and after. */
export function parseGitDiff(diff: string): GitDiff {
  const result: GitDiff = { lines: [], added: 0, removed: 0, binary: false };
  let hunk = false;
  let old = 0;
  let next = 0;
  for (const line of diff.split("\n")) {
    if (line.startsWith("diff --git ")) hunk = false;
    else if (line.startsWith("@@")) {
      const range = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
      old = Number(range?.[1] ?? 0);
      next = Number(range?.[2] ?? 0);
      hunk = true;
      result.lines.push({ kind: "hunk", text: line });
    } else if (!hunk) {
      if (line.startsWith("Binary files ")) result.binary = true;
    } else if (line.startsWith("+")) {
      result.lines.push({ kind: "added", text: line.slice(1), new: next++ });
      result.added++;
    } else if (line.startsWith("-")) {
      result.lines.push({ kind: "removed", text: line.slice(1), old: old++ });
      result.removed++;
    } else if (line.startsWith(" "))
      result.lines.push({
        kind: "same",
        text: line.slice(1),
        old: old++,
        new: next++,
      });
  }
  return result;
}

/** The owner's note on lines of a file, as input for the session: where, then what. */
export const lineComment = (
  path: string,
  from: number,
  to: number,
  text: string,
) => `${path}:${from === to ? from : `${from}-${to}`}: ${text.trim()}`;

/** A check of a pull request, from GitHub's checks or its commit statuses. */
export interface Check {
  name: string;
  state: "pending" | "passed" | "failed" | "skipped";
  url?: string;
}

/** GitHub's check run or commit status, as `gh` gives it. */
type RawCheck =
  | {
      __typename: "CheckRun";
      name: string;
      status: string;
      conclusion: string | null;
      detailsUrl?: string;
    }
  | {
      __typename: "StatusContext";
      context: string;
      state: string;
      targetUrl?: string;
    };

/** The branch's pull request, as GitHub's `gh` reads it. */
export interface PullRequest {
  number: number;
  url: string;
  title: string;
  state: "OPEN" | "CLOSED" | "MERGED";
  isDraft: boolean;
  mergeable: "MERGEABLE" | "CONFLICTING" | "UNKNOWN";
  reviewDecision: "APPROVED" | "CHANGES_REQUESTED" | "REVIEW_REQUIRED" | "";
  headRefName: string;
  baseRefName: string;
  statusCheckRollup: RawCheck[] | null;
}

/** A pull request's checks, each passed, failed, skipped or still running. */
export function checksOf(pr: PullRequest): Check[] {
  return (pr.statusCheckRollup ?? []).map((check) => {
    if (check.__typename === "StatusContext")
      return {
        name: check.context,
        state:
          check.state === "SUCCESS"
            ? "passed"
            : check.state === "PENDING" || check.state === "EXPECTED"
              ? "pending"
              : "failed",
        url: check.targetUrl,
      };
    return {
      name: check.name,
      state:
        check.status !== "COMPLETED"
          ? "pending"
          : check.conclusion === "SUCCESS"
            ? "passed"
            : check.conclusion === "SKIPPED" || check.conclusion === "NEUTRAL"
              ? "skipped"
              : "failed",
      url: check.detailsUrl,
    };
  });
}

const at = (sessionId: string) => `/sessions/${encodeURIComponent(sessionId)}`;

/** A file of the session's folder, its text as it is now. */
export const sessionFile = (
  sessionId: string,
  path: string,
  kernel = kernelUrl(),
) =>
  request<{ path: string; text: string }>(
    kernel,
    `${at(sessionId)}/file?path=${encodeURIComponent(path)}`,
  ).then(({ text }) => text);

/**
 * What git sees in the session's folder, read again whenever `revision` changes (as when the
 * session's record grows); and the owner's actions on it, each answered with the new state.
 * Nothing is read without a session, as for someone who is not its owner.
 */
export function useSessionGit(
  sessionId: string | undefined,
  revision: unknown,
  kernel = kernelUrl(),
) {
  const [read, setRead] = useState<{
    session: string;
    status?: GitStatus;
    error?: string;
  }>();
  const session = `${kernel}\n${sessionId}`;
  const reload = useCallback(
    async () =>
      sessionId === undefined
        ? undefined
        : request<GitStatus>(kernel, `${at(sessionId)}/git`).then(
            (status) => setRead({ session, status }),
            (error: unknown) =>
              setRead((was) => ({
                ...(was?.session === session ? was : { session }),
                error: errorMessage(error),
              })),
          ),
    [kernel, sessionId, session],
  );
  useEffect(() => void reload(), [reload, revision]);
  const act = (action: string, body: unknown) =>
    request<GitStatus>(kernel, `${at(sessionId!)}/git/${action}`, body).then(
      (status) => setRead({ session, status }),
    );
  const current = read?.session === session ? read : undefined;
  return {
    status: current?.status,
    error: current?.error ?? "",
    reload,
    stage: (paths: string[]) => act("stage", { paths }),
    unstage: (paths: string[]) => act("unstage", { paths }),
    /** Throws away what is not staged; an untracked file is removed. */
    discard: (paths: string[]) => act("discard", { paths }),
    async commit(message: string) {
      const { commit } = await request<{ commit: string }>(
        kernel,
        `${at(sessionId!)}/git/commit`,
        { message },
      );
      await reload();
      return commit;
    },
    /** Pushes the branch; one without an upstream gets one on `origin`. */
    push: () => act("push", {}),
  };
}

/**
 * A file's changes as lines: those not staged yet, or the staged ones. Read again when
 * `revision` changes; none while it is read.
 */
export function useSessionDiff(
  sessionId: string,
  path: string | undefined,
  staged: boolean,
  revision: unknown,
  kernel = kernelUrl(),
) {
  const [read, setRead] = useState<{
    key: string;
    diff?: GitDiff;
    error?: string;
  }>();
  const key = `${kernel}\n${sessionId}\n${path}\n${staged}`;
  useEffect(() => {
    if (path === undefined) return;
    const controller = new AbortController();
    request<{ diff: string }>(
      kernel,
      `${at(sessionId)}/git/diff?path=${encodeURIComponent(path)}&staged=${staged}`,
      undefined,
      controller.signal,
    ).then(
      ({ diff }) => setRead({ key, diff: parseGitDiff(diff) }),
      (error: unknown) => {
        if (!controller.signal.aborted)
          setRead({ key, error: errorMessage(error) });
      },
    );
    return () => controller.abort();
  }, [kernel, sessionId, path, staged, key, revision]);
  const current = read?.key === key ? read : undefined;
  return { diff: current?.diff, error: current?.error };
}

/** How often a pull request with checks still running is read again. */
const CHECKS_MS = 30_000;

/**
 * The branch's pull request with its checks, through `gh` on the kernel's host: null when there
 * is none. Read again when `revision` changes, and while checks are still running; nothing
 * without a session.
 */
export function useSessionPullRequest(
  sessionId: string | undefined,
  revision: unknown,
  kernel = kernelUrl(),
) {
  const [read, setRead] = useState<{
    session: string;
    pullRequest?: PullRequest | null;
    error?: string;
  }>();
  const session = `${kernel}\n${sessionId}`;
  const reload = useCallback(
    async () =>
      sessionId === undefined
        ? undefined
        : request<{ pull_request: PullRequest | null }>(
            kernel,
            `${at(sessionId)}/git/pr`,
          ).then(
            ({ pull_request }) =>
              setRead({ session, pullRequest: pull_request }),
            (error: unknown) =>
              setRead({ session, error: errorMessage(error) }),
          ),
    [kernel, sessionId, session],
  );
  useEffect(() => void reload(), [reload, revision]);
  const current = read?.session === session ? read : undefined;
  const running =
    current?.pullRequest?.state === "OPEN" &&
    checksOf(current.pullRequest).some((check) => check.state === "pending");
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => void reload(), CHECKS_MS);
    return () => clearInterval(timer);
  }, [running, reload]);
  return {
    pullRequest: current?.pullRequest,
    error: current?.error ?? "",
    reload,
    /** Opens a pull request for the branch; its address. */
    async open(input: { title: string; body: string; draft: boolean }) {
      const { url } = await request<{ url: string }>(
        kernel,
        `${at(sessionId!)}/git/pr`,
        input,
      );
      await reload();
      return url;
    },
  };
}
