import { cn } from "cn";
import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import {
  ArrowLeftIcon,
  CircleCheckIcon,
  CircleDashedIcon,
  CircleMinusIcon,
  CircleXIcon,
  GitBranchIcon,
  GitPullRequestIcon,
  MinusIcon,
  PlusIcon,
  RefreshCwIcon,
  Undo2Icon,
  XIcon,
} from "lucide-react";
import {
  changeLabels,
  checksOf,
  closeTerminal,
  errorMessage,
  followTerminal,
  isStaged,
  isUnstaged,
  lineComment,
  openTerminal,
  resizeTerminal,
  sessionTerminals,
  terminalReader,
  terminalWriter,
  sessionFile,
  useSessionDiff,
  useSessionFiles,
  useSessionPullRequest,
  writeTerminal,
} from "@zerolux/chat";
import type {
  ChatSession,
  Check,
  GitChange,
  GitDiffLine,
  Perform,
  TerminalInfo,
  useSessionGit,
} from "@zerolux/chat";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { useTheme } from "./theme";

/** The panels of a session's code, opened by its owner beside its work. */
export type CodePane = "changes" | "files" | "terminal" | "subagent";

type Git = ReturnType<typeof useSessionGit>;

/** A panel's frame: its title and actions on top, then what it shows, scrolling. */
export function Pane({
  title,
  actions,
  close,
  children,
}: {
  title: ReactNode;
  actions?: ReactNode;
  close: () => void;
  children: ReactNode;
}) {
  return (
    <section className="flex h-full min-h-0 flex-col bg-background">
      <header className="flex min-h-14 shrink-0 items-center gap-2 border-b px-3">
        <h2 className="flex min-w-0 flex-1 items-center gap-2 text-sm font-medium">
          {title}
        </h2>
        {actions}
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Close"
          onClick={close}
        >
          <XIcon />
        </Button>
      </header>
      {children}
    </section>
  );
}

/** A path as a list shows it: the file's name, then its folder, faint. */
function PathName({ path }: { path: string }) {
  const cut = path.replace(/\/$/, "").lastIndexOf("/");
  return (
    <span className="flex min-w-0 items-baseline gap-1.5">
      <span className="shrink-0 font-mono text-[12.5px]">
        {path.slice(cut + 1)}
      </span>
      {cut > 0 && (
        <span className="truncate font-mono text-[11px] text-faint">
          {path.slice(0, cut)}
        </span>
      )}
    </span>
  );
}

/**
 * Git's letter for a change, colored as what it did. Untracked reads as U, as editors show
 * it, so a conflict (git's U) reads as !.
 */
function Letter({ letter }: { letter: string }) {
  return (
    <span
      title={changeLabels[letter] ?? letter}
      className={cn(
        "w-3 shrink-0 text-center font-mono text-[11px] font-medium",
        letter === "A" || letter === "?"
          ? "text-success"
          : letter === "D" || letter === "U"
            ? "text-destructive"
            : "text-attention",
      )}
    >
      {letter === "?" ? "U" : letter === "U" ? "!" : letter}
    </span>
  );
}

/**
 * What changed in the session's folder, as git sees it: what is staged for the next commit and
 * what is not, each file's diff with notes on its lines for the session, the commit, the push,
 * and the branch's pull request with its checks.
 */
export function ChangesPanel({
  session,
  name,
  git,
  revision,
  busy,
  perform,
  send,
  act,
  close,
}: {
  session: ChatSession;
  name: string;
  git: Git;
  revision: unknown;
  busy: boolean;
  perform: Perform;
  /**
   * Writes into the session as input; none for someone it is shared with only to read, who
   * sees its changes without acting on them.
   */
  send?: (text: string) => Promise<void>;
  /** Staging, discarding, committing, pushing and pull requests; what is only read has none. */
  act?: boolean;
  close: () => void;
}) {
  const write = act ?? send !== undefined;
  const [open, setOpen] = useState<{ path: string; staged: boolean }>();
  const [discarding, setDiscarding] = useState<string[]>();
  const status = git.status;
  const staged = status?.changes.filter(isStaged) ?? [];
  const unstaged = status?.changes.filter(isUnstaged) ?? [];
  const opened = status?.changes.find((change) => change.path === open?.path);
  // A file that is no longer changed closes; one that left its side opens on the other.
  const side =
    opened && open
      ? (open.staged ? isStaged(opened) : isUnstaged(opened))
        ? open.staged
        : !open.staged
      : undefined;
  const confirm = discarding && (
    <div className="flex flex-col gap-2 rounded-md bg-destructive/10 p-3 text-sm">
      <p>
        Throw away the changes to{" "}
        {discarding.length === 1 ? (
          <span className="font-mono text-[12.5px]">{discarding[0]}</span>
        ) : (
          `${discarding.length} files`
        )}{" "}
        that are not staged? An untracked file is deleted. This cannot be
        undone.
      </p>
      <div className="flex gap-2">
        <Button
          variant="destructive"
          size="sm"
          disabled={busy}
          onClick={() =>
            void perform(() => git.discard(discarding)).then(
              (done) => done && setDiscarding(undefined),
            )
          }
        >
          Discard
        </Button>
        <Button
          variant="outline"
          size="sm"
          onClick={() => setDiscarding(undefined)}
        >
          Keep them
        </Button>
      </div>
    </div>
  );
  if (open && opened && side !== undefined)
    return (
      <Pane
        title={
          <>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="All changes"
              onClick={() => setOpen(undefined)}
            >
              <ArrowLeftIcon />
            </Button>
            <Letter letter={side ? opened.staged : opened.unstaged} />
            <PathName path={opened.path} />
          </>
        }
        actions={
          write && (
            <ChangeActions
              change={opened}
              staged={side}
              git={git}
              busy={busy}
              perform={perform}
              discard={() => setDiscarding([opened.path])}
            />
          )
        }
        close={close}
      >
        <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-3">
          {confirm}
          {opened.from && (
            <p className="font-mono text-[11px] text-faint">
              Renamed from {opened.from}
            </p>
          )}
          <FileDiff
            sessionId={session.id}
            path={opened.path}
            staged={side}
            revision={revision}
            name={name}
            busy={busy}
            perform={perform}
            send={send}
          />
        </div>
      </Pane>
    );
  return (
    <Pane
      title={
        <>
          Changes
          {status?.branch && (
            <span className="flex min-w-0 items-center gap-1 font-mono text-[11px] font-normal text-faint">
              <GitBranchIcon className="size-3 shrink-0" />
              <span className="truncate">{status.branch}</span>
            </span>
          )}
        </>
      }
      actions={
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Read again"
          onClick={() => void git.reload()}
        >
          <RefreshCwIcon />
        </Button>
      }
      close={close}
    >
      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-3">
        {git.error && (
          <p role="alert" className="text-sm text-destructive">
            {git.error}
          </p>
        )}
        {status && (
          <>
            <Branch git={git} write={write} busy={busy} perform={perform} />
            <PullRequestBox
              sessionId={session.id}
              revision={revision}
              pushed={!!status.upstream}
              write={write}
              busy={busy}
              perform={perform}
            />
            {confirm}
            {write && staged.length > 0 && (
              <Commit
                count={staged.length}
                git={git}
                busy={busy}
                perform={perform}
              />
            )}
            <ChangeList
              title="Staged"
              changes={staged}
              staged
              write={write}
              git={git}
              busy={busy}
              perform={perform}
              open={(path) => setOpen({ path, staged: true })}
              discard={setDiscarding}
            />
            <ChangeList
              title="Changes"
              changes={unstaged}
              staged={false}
              write={write}
              git={git}
              busy={busy}
              perform={perform}
              open={(path) => setOpen({ path, staged: false })}
              discard={setDiscarding}
            />
            {!status.changes.length && (
              <p className="text-sm text-muted-foreground">
                Nothing changed since the last commit.
              </p>
            )}
          </>
        )}
      </div>
    </Pane>
  );
}

/** Stage, unstage or discard one change, as its side allows. */
function ChangeActions({
  change,
  staged,
  git,
  busy,
  perform,
  discard,
}: {
  change: GitChange;
  staged: boolean;
  git: Git;
  busy: boolean;
  perform: Perform;
  discard: () => void;
}) {
  const paths = [change.path];
  return staged ? (
    <Button
      variant="ghost"
      size="icon-sm"
      aria-label={`Unstage ${change.path}`}
      title="Unstage"
      disabled={busy}
      onClick={() => void perform(() => git.unstage(paths))}
    >
      <MinusIcon />
    </Button>
  ) : (
    <>
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label={`Discard ${change.path}`}
        title="Discard"
        disabled={busy}
        onClick={discard}
      >
        <Undo2Icon />
      </Button>
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label={`Stage ${change.path}`}
        title="Stage"
        disabled={busy}
        onClick={() => void perform(() => git.stage(paths))}
      >
        <PlusIcon />
      </Button>
    </>
  );
}

/** One side's changes, each opened to its diff; staged or not, all at once too. */
function ChangeList({
  title,
  changes,
  staged,
  write,
  git,
  busy,
  perform,
  open,
  discard,
}: {
  title: string;
  changes: GitChange[];
  staged: boolean;
  /** Who may only read sees the changes, without the actions. */
  write: boolean;
  git: Git;
  busy: boolean;
  perform: Perform;
  open: (path: string) => void;
  discard: (paths: string[]) => void;
}) {
  if (!changes.length) return null;
  const paths = changes.map((change) => change.path);
  return (
    <section aria-label={title} className="flex flex-col gap-1">
      <div className="flex items-center gap-2">
        <h3 className="flex-1 font-mono text-[11px] tracking-wide text-faint uppercase">
          {title} · {changes.length}
        </h3>
        {!write ? null : staged ? (
          <Button
            variant="ghost"
            size="sm"
            disabled={busy}
            onClick={() => void perform(() => git.unstage(paths))}
          >
            Unstage all
          </Button>
        ) : (
          <>
            <Button
              variant="ghost"
              size="sm"
              disabled={busy}
              onClick={() => discard(paths)}
            >
              Discard all
            </Button>
            <Button
              variant="ghost"
              size="sm"
              disabled={busy}
              onClick={() => void perform(() => git.stage(paths))}
            >
              Stage all
            </Button>
          </>
        )}
      </div>
      <ul className="flex flex-col">
        {changes.map((change) => (
          <li
            key={change.path}
            className="group flex items-center gap-2 rounded-sm pr-1 hover:bg-accent"
          >
            <button
              type="button"
              onClick={() => open(change.path)}
              className="flex min-w-0 flex-1 items-center gap-2 py-1.5 pl-2 text-left outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
            >
              <Letter letter={staged ? change.staged : change.unstaged} />
              <PathName path={change.path} />
            </button>
            {write && (
              <span className="flex shrink-0 opacity-0 group-focus-within:opacity-100 group-hover:opacity-100">
                <ChangeActions
                  change={change}
                  staged={staged}
                  git={git}
                  busy={busy}
                  perform={perform}
                  discard={() => discard([change.path])}
                />
              </span>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

/** A commit of what is staged, with the owner's message. */
function Commit({
  count,
  git,
  busy,
  perform,
}: {
  count: number;
  git: Git;
  busy: boolean;
  perform: Perform;
}) {
  const [message, setMessage] = useState("");
  return (
    <form
      className="flex flex-col gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        if (message.trim())
          void perform(async () => void (await git.commit(message))).then(
            (done) => done && setMessage(""),
          );
      }}
    >
      <Textarea
        aria-label="Commit message"
        placeholder="Commit message"
        value={message}
        rows={2}
        onChange={(event) => setMessage(event.target.value)}
        className="min-h-14 font-mono text-[12.5px]"
      />
      <Button type="submit" size="sm" disabled={busy || !message.trim()}>
        Commit {count === 1 ? "1 file" : `${count} files`}
      </Button>
    </form>
  );
}

/** Where the branch stands against its upstream, and the push that brings it there. */
function Branch({
  git,
  write,
  busy,
  perform,
}: {
  git: Git;
  /** Pushing is for whoever may write to the session. */
  write: boolean;
  busy: boolean;
  perform: Perform;
}) {
  const status = git.status!;
  if (!status.branch)
    return (
      <p className="text-sm text-muted-foreground">
        No branch is checked out (detached HEAD).
      </p>
    );
  const publish = !status.upstream;
  return (
    <div className="flex items-center gap-2 text-sm">
      <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-muted-foreground">
        {publish
          ? "Not on a remote yet"
          : `${status.upstream} · ${status.ahead} ahead · ${status.behind} behind`}
      </span>
      {write && (publish || status.ahead > 0) && (
        <Button
          size="sm"
          variant="outline"
          disabled={busy}
          onClick={() => void perform(() => git.push())}
        >
          {publish
            ? "Publish branch"
            : `Push ${status.ahead === 1 ? "1 commit" : `${status.ahead} commits`}`}
        </Button>
      )}
    </div>
  );
}

const checkIcons: Record<Check["state"], ReactNode> = {
  passed: <CircleCheckIcon className="size-3.5 text-success" />,
  failed: <CircleXIcon className="size-3.5 text-destructive" />,
  pending: (
    <CircleDashedIcon className="size-3.5 animate-spin text-attention" />
  ),
  skipped: <CircleMinusIcon className="size-3.5 text-faint" />,
};

const prStates = {
  OPEN: "Open",
  CLOSED: "Closed",
  MERGED: "Merged",
} as const;

/** The branch's pull request with its checks, through `gh`; or the form that opens one. */
function PullRequestBox({
  sessionId,
  revision,
  pushed,
  write,
  busy,
  perform,
}: {
  sessionId: string;
  revision: unknown;
  pushed: boolean;
  /** Opening one is for whoever may write to the session. */
  write: boolean;
  busy: boolean;
  perform: Perform;
}) {
  const pr = useSessionPullRequest(sessionId, revision);
  const [draft, setDraft] = useState<{
    title: string;
    body: string;
    draft: boolean;
  }>();
  const request = pr.pullRequest;
  if (pr.error)
    return <p className="text-xs text-faint">Pull request: {pr.error}</p>;
  if (request === undefined) return null;
  if (request) {
    const checks = checksOf(request);
    const count = (state: Check["state"]) =>
      checks.filter((check) => check.state === state).length;
    const summary = [
      count("passed") && `${count("passed")} passed`,
      count("failed") && `${count("failed")} failed`,
      count("pending") && `${count("pending")} running`,
    ].filter(Boolean);
    return (
      <section
        aria-label="Pull request"
        className="flex flex-col gap-2 rounded-md border p-3 text-sm"
      >
        <a
          href={request.url}
          target="_blank"
          rel="noreferrer"
          className="flex min-w-0 items-center gap-2 font-medium hover:underline"
        >
          <GitPullRequestIcon className="size-4 shrink-0 text-faint" />
          <span className="truncate">
            #{request.number} {request.title}
          </span>
        </a>
        <p className="font-mono text-[11px] text-faint">
          {request.isDraft ? "Draft" : prStates[request.state]} ·{" "}
          {request.headRefName} → {request.baseRefName}
          {request.reviewDecision === "APPROVED" && " · Approved"}
          {request.reviewDecision === "CHANGES_REQUESTED" &&
            " · Changes requested"}
          {request.mergeable === "CONFLICTING" && " · Conflicts"}
        </p>
        {checks.length > 0 && (
          <>
            <p className="text-xs text-muted-foreground">
              Checks: {summary.join(" · ") || "none ran"}
            </p>
            <ul className="flex flex-col gap-1">
              {checks
                .filter((check) => check.state !== "passed")
                .map((check, i) => (
                  <li
                    key={`${check.name}-${i}`}
                    className="flex items-center gap-2 text-xs"
                  >
                    {checkIcons[check.state]}
                    {check.url ? (
                      <a
                        href={check.url}
                        target="_blank"
                        rel="noreferrer"
                        className="truncate hover:underline"
                      >
                        {check.name}
                      </a>
                    ) : (
                      <span className="truncate">{check.name}</span>
                    )}
                  </li>
                ))}
            </ul>
          </>
        )}
      </section>
    );
  }
  if (!pushed || !write) return null;
  if (!draft)
    return (
      <Button
        variant="outline"
        size="sm"
        className="self-start"
        onClick={() => setDraft({ title: "", body: "", draft: false })}
      >
        <GitPullRequestIcon data-icon="inline-start" />
        Open a pull request
      </Button>
    );
  return (
    <form
      aria-label="New pull request"
      className="flex flex-col gap-2 rounded-md border p-3"
      onSubmit={(event) => {
        event.preventDefault();
        void perform(async () => void (await pr.open(draft))).then(
          (done) => done && setDraft(undefined),
        );
      }}
    >
      <Input
        aria-label="Title"
        placeholder="Title"
        value={draft.title}
        maxLength={1000}
        autoFocus
        onChange={(event) => setDraft({ ...draft, title: event.target.value })}
      />
      <Textarea
        aria-label="Description"
        placeholder="Description"
        value={draft.body}
        rows={4}
        onChange={(event) => setDraft({ ...draft, body: event.target.value })}
      />
      <label className="flex items-center gap-2 text-sm">
        <Checkbox
          checked={draft.draft}
          onCheckedChange={(checked) =>
            setDraft({ ...draft, draft: checked === true })
          }
        />
        Draft
      </label>
      <div className="flex gap-2">
        <Button type="submit" size="sm" disabled={busy || !draft.title.trim()}>
          Open
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={() => setDraft(undefined)}
        >
          Cancel
        </Button>
      </div>
    </form>
  );
}

/** A numbered line of a diff or a file: its kind, its text, and the line a note names. */
interface Row {
  kind: GitDiffLine["kind"];
  text: string;
  /** Before and after for a diff, one for a file; none for a hunk's header. */
  numbers: (number | undefined)[];
  /** The line a note on it names: the file after, or before for a removed one. */
  line: number;
}

/**
 * Numbered lines of a file. Choosing a line's number, and another with Shift, opens a note on
 * those lines that goes to the session as the owner's input.
 */
function NotedLines({
  rows,
  path,
  label,
  signs,
  name,
  busy,
  perform,
  send,
}: {
  rows: Row[];
  path: string;
  label: string;
  /** A diff marks what was added and removed. */
  signs: boolean;
  name: string;
  busy: boolean;
  perform: Perform;
  /** Notes go to the session as input; without it, the lines are only read. */
  send?: (text: string) => Promise<void>;
}) {
  const [chosen, setChosen] = useState<{ from: number; to: number }>();
  const [note, setNote] = useState("");
  const range = chosen && {
    from: Math.min(chosen.from, chosen.to),
    to: Math.max(chosen.from, chosen.to),
  };
  const noteBox = range && (
    <form
      className="flex flex-col gap-2 border-y bg-card p-2 font-sans"
      onSubmit={(event) => {
        event.preventDefault();
        const text = lineComment(
          path,
          rows[range.from]!.line,
          rows[range.to]!.line,
          note,
        );
        if (note.trim() && send)
          void perform(() => send(text)).then((done) => {
            if (!done) return;
            setNote("");
            setChosen(undefined);
          });
      }}
    >
      <Textarea
        aria-label="Note on these lines"
        placeholder={`A note for ${name} on these lines`}
        value={note}
        rows={2}
        autoFocus
        onChange={(event) => setNote(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            setChosen(undefined);
          }
        }}
        className="min-h-14 text-sm"
      />
      <div className="flex gap-2">
        <Button type="submit" size="sm" disabled={busy || !note.trim()}>
          Send to {name}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={() => setChosen(undefined)}
        >
          Cancel
        </Button>
      </div>
    </form>
  );
  return (
    <div
      role="table"
      aria-label={label}
      className="overflow-x-auto rounded-md border py-1 font-mono text-[12px]"
    >
      {rows.map((row, i) => (
        <div key={i} role="rowgroup">
          <div
            role="row"
            className={cn(
              "flex min-w-max",
              row.kind === "hunk" && "bg-muted/60 text-faint",
              row.kind === "added" && "bg-success/10",
              row.kind === "removed" && "bg-destructive/10",
              range && i >= range.from && i <= range.to && "bg-primary/15",
            )}
          >
            {row.kind === "hunk" ? (
              <span className="px-3 py-0.5">{row.text}</span>
            ) : (
              <>
                <button
                  type="button"
                  aria-label={`Note on line ${row.line}`}
                  disabled={!send}
                  onClick={(event) =>
                    setChosen(
                      event.shiftKey && chosen
                        ? { ...chosen, to: i }
                        : { from: i, to: i },
                    )
                  }
                  className="flex shrink-0 text-faint select-none enabled:hover:text-foreground"
                >
                  {row.numbers.map((number, n) => (
                    <span key={n} className="w-10 pr-1 text-right">
                      {number}
                    </span>
                  ))}
                </button>
                {signs && (
                  <span
                    aria-hidden
                    className={cn(
                      "w-4 shrink-0 text-center select-none",
                      row.kind === "added" && "text-success",
                      row.kind === "removed" && "text-destructive",
                    )}
                  >
                    {row.kind === "added"
                      ? "+"
                      : row.kind === "removed"
                        ? "−"
                        : ""}
                  </span>
                )}
                <span className="pr-3 pl-2 whitespace-pre">
                  {row.text || " "}
                </span>
              </>
            )}
          </div>
          {range?.to === i && noteBox}
        </div>
      ))}
    </div>
  );
}

/** A file's diff, numbered before and after, with notes on its lines for the session. */
export function FileDiff({
  sessionId,
  path,
  staged,
  revision,
  name,
  busy,
  perform,
  send,
}: {
  sessionId: string;
  path: string;
  staged: boolean;
  revision: unknown;
  name: string;
  busy: boolean;
  perform: Perform;
  send?: (text: string) => Promise<void>;
}) {
  const { diff, error } = useSessionDiff(sessionId, path, staged, revision);
  if (error)
    return (
      <p role="alert" className="text-sm text-destructive">
        {error}
      </p>
    );
  if (!diff) return null;
  if (diff.binary)
    return <p className="text-sm text-muted-foreground">A binary file.</p>;
  return (
    <div className="flex flex-col gap-2">
      <p className="font-mono text-[11px] text-faint">
        <span className="text-success">+{diff.added}</span>{" "}
        <span className="text-destructive">−{diff.removed}</span>
        {send && " · choose a line's number to write a note on it"}
      </p>
      <NotedLines
        rows={diff.lines.map((line) => ({
          kind: line.kind,
          text: line.text,
          numbers: [line.old, line.new],
          line: line.new ?? line.old ?? 0,
        }))}
        path={path}
        label={`Diff of ${path}`}
        signs
        name={name}
        busy={busy}
        perform={perform}
        send={send}
      />
    </div>
  );
}

/**
 * The files of the session's folder, found by what is typed, best first; one opened shows its
 * text as it is now, numbered, with notes on its lines for the session.
 */
export function FilesPanel({
  session,
  name,
  revision,
  busy,
  perform,
  send,
  close,
}: {
  session: ChatSession;
  name: string;
  revision: unknown;
  busy: boolean;
  perform: Perform;
  send?: (text: string) => Promise<void>;
  close: () => void;
}) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState<string>();
  const files = useSessionFiles(session.id, query);
  const [read, setRead] = useState<{
    path: string;
    text?: string;
    error?: string;
  }>();
  useEffect(() => {
    if (open === undefined) return;
    let current = true;
    sessionFile(session.id, open).then(
      (text) => current && setRead({ path: open, text }),
      (failed: unknown) =>
        current && setRead({ path: open, error: errorMessage(failed) }),
    );
    return () => {
      current = false;
    };
  }, [session.id, open, revision]);
  const shown = read?.path === open ? read : undefined;
  if (open !== undefined)
    return (
      <Pane
        title={
          <>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="All files"
              onClick={() => setOpen(undefined)}
            >
              <ArrowLeftIcon />
            </Button>
            <PathName path={open} />
          </>
        }
        close={close}
      >
        <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto p-3">
          {shown?.error && (
            <p role="alert" className="text-sm text-destructive">
              {shown.error}
            </p>
          )}
          {shown?.text !== undefined && (
            <NotedLines
              rows={shown.text.split("\n").map((text, i) => ({
                kind: "same",
                text,
                numbers: [i + 1],
                line: i + 1,
              }))}
              path={open}
              label={open}
              signs={false}
              name={name}
              busy={busy}
              perform={perform}
              send={send}
            />
          )}
        </div>
      </Pane>
    );
  return (
    <Pane title="Files" close={close}>
      <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto p-3">
        <Input
          type="search"
          aria-label="Find a file"
          placeholder="Find a file"
          value={query}
          autoFocus
          onChange={(event) => setQuery(event.target.value)}
        />
        <ul className="flex flex-col">
          {files.map((path) => (
            <li key={path}>
              <button
                type="button"
                onClick={() => setOpen(path)}
                className="flex w-full min-w-0 items-center rounded-sm px-2 py-1.5 text-left outline-none hover:bg-accent focus-visible:ring-3 focus-visible:ring-ring/50"
              >
                <PathName path={path} />
              </button>
            </li>
          ))}
        </ul>
      </div>
    </Pane>
  );
}

/** A theme color, as the page has it now. */
const color = (name: string) =>
  getComputedStyle(document.documentElement)
    .getPropertyValue(`--color-${name}`)
    .trim();

// The ANSI colors on a light background, as VS Code's light terminal has them; the dark
// background keeps xterm's own.
const LIGHT = {
  black: "#000000",
  red: "#cd3131",
  green: "#00bc00",
  yellow: "#949800",
  blue: "#0451a5",
  magenta: "#bc05bc",
  cyan: "#0598bc",
  white: "#555555",
  brightBlack: "#666666",
  brightRed: "#cd3131",
  brightGreen: "#14ce14",
  brightYellow: "#b5ba00",
  brightBlue: "#0451a5",
  brightMagenta: "#bc05bc",
  brightCyan: "#0598bc",
  brightWhite: "#a5a5a5",
};

/** The terminal's colors from the theme in use. */
function terminalTheme(dark: boolean) {
  return {
    ...(dark ? {} : LIGHT),
    background: color("background"),
    foreground: color("foreground"),
    cursor: color("foreground"),
    cursorAccent: color("background"),
    selectionBackground: color("faint"),
  };
}

/**
 * One terminal, drawn by xterm.js: its output from all the kernel keeps, then as it comes;
 * what is typed goes to its shell, in order; its size follows the panel.
 */
function TerminalScreen({
  terminal,
  ended,
}: {
  terminal: TerminalInfo;
  ended: () => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const screen = useRef<Terminal>(null);
  const { resolved, theme } = useTheme();
  const done = useRef(ended);
  done.current = ended;
  useEffect(() => {
    if (!host.current) return;
    const xterm = new Terminal({
      fontFamily: getComputedStyle(document.documentElement)
        .getPropertyValue("--font-mono")
        .trim(),
      fontSize: 12.5,
      cursorBlink: true,
      scrollback: 5000,
    });
    const fit = new FitAddon();
    xterm.loadAddon(fit);
    xterm.open(host.current);
    const write = terminalWriter((data) => writeTerminal(terminal.id, data));
    const typed = xterm.onData((data) => void write(data));
    const resized = xterm.onResize(
      ({ cols, rows }) =>
        void resizeTerminal(terminal.id, { cols, rows }).catch(() => {}),
    );
    fit.fit();
    if (xterm.cols !== terminal.cols || xterm.rows !== terminal.rows)
      void resizeTerminal(terminal.id, {
        cols: xterm.cols,
        rows: xterm.rows,
      }).catch(() => {});
    const watch = new ResizeObserver(() => fit.fit());
    watch.observe(host.current);
    const stop = followTerminal(
      terminal.id,
      terminalReader(terminal.id),
      (data) =>
        xterm.write(Uint8Array.from(atob(data), (c) => c.charCodeAt(0))),
      () => done.current(),
    );
    screen.current = xterm;
    xterm.focus();
    return () => {
      stop();
      watch.disconnect();
      typed.dispose();
      resized.dispose();
      xterm.dispose();
      screen.current = null;
    };
    // A terminal's size at first is read once; later sizes come from the panel.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [terminal.id]);
  useEffect(() => {
    if (screen.current)
      screen.current.options.theme = terminalTheme(resolved === "dark");
  }, [resolved, theme]);
  return <div ref={host} className="min-h-0 flex-1 overflow-hidden p-2" />;
}

/**
 * The session's terminals, shells in its folder on the kernel's host: one opens when there is
 * none, more beside it; each stays until closed or until the session stops.
 */
export function TerminalPanel({
  session,
  perform,
  close,
}: {
  session: ChatSession;
  perform: Perform;
  close: () => void;
}) {
  const [terminals, setTerminals] = useState<TerminalInfo[]>();
  const [shown, setShown] = useState<string>();
  const [error, setError] = useState("");
  const add = () =>
    perform(async () => {
      const terminal = await openTerminal(session.id, { cols: 80, rows: 24 });
      setTerminals((all) => [...(all ?? []), terminal]);
      setShown(terminal.id);
    });
  useEffect(() => {
    let current = true;
    sessionTerminals(session.id).then(
      (found) => {
        if (!current) return;
        const live = found.filter((terminal) => !terminal.ended);
        setTerminals(live);
        if (live.length) setShown(live[0]!.id);
        else void add();
      },
      (failed: unknown) => current && setError(errorMessage(failed)),
    );
    return () => {
      current = false;
    };
    // The session's terminals are read when the panel opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.id]);
  const terminal = terminals?.find((t) => t.id === shown);
  const ended = (id: string) =>
    setTerminals((all) =>
      all?.map((t) => (t.id === id ? { ...t, ended: true } : t)),
    );
  const remove = (id: string) =>
    perform(async () => {
      await closeTerminal(id);
      const rest = (terminals ?? []).filter((t) => t.id !== id);
      setTerminals(rest);
      if (shown === id) setShown(rest[0]?.id);
    });
  return (
    <Pane
      title={
        <span className="flex min-w-0 items-center gap-1 overflow-x-auto">
          {(terminals ?? []).map((t, i) => (
            <span
              key={t.id}
              className={cn(
                "flex shrink-0 items-center rounded-sm text-[13px]",
                t.id === shown ? "bg-accent" : "text-muted-foreground",
              )}
            >
              <button
                type="button"
                aria-pressed={t.id === shown}
                onClick={() => setShown(t.id)}
                className="px-2 py-1 font-mono outline-none"
              >
                Shell {i + 1}
                {t.ended && " · ended"}
              </button>
              <button
                type="button"
                aria-label={`Close shell ${i + 1}`}
                onClick={() => void remove(t.id)}
                className="pr-1.5 text-faint hover:text-foreground"
              >
                <XIcon className="size-3" />
              </button>
            </span>
          ))}
        </span>
      }
      actions={
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="New terminal"
          onClick={() => void add()}
        >
          <PlusIcon />
        </Button>
      }
      close={close}
    >
      {error && (
        <p role="alert" className="p-3 text-sm text-destructive">
          {error}
        </p>
      )}
      {terminal && (
        <TerminalScreen
          key={terminal.id}
          terminal={terminal}
          ended={() => ended(terminal.id)}
        />
      )}
      {terminals?.length === 0 && (
        <p className="p-3 text-sm text-muted-foreground">
          No terminal is open.
        </p>
      )}
    </Pane>
  );
}
