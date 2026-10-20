import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { Link, NavLink, useNavigate, useSearchParams } from "react-router";
import { cn } from "cn";
import {
  ArchiveIcon,
  ArchiveRestoreIcon,
  ChevronLeftIcon,
  ChevronDownIcon,
  EllipsisIcon,
  FileSearchIcon,
  GitCompareArrowsIcon,
  GitForkIcon,
  ImagePlusIcon,
  InfoIcon,
  ListChecksIcon,
  MessageCircleQuestionIcon,
  SearchIcon,
  PencilIcon,
  PinIcon,
  PinOffIcon,
  PlusIcon,
  SendIcon,
  SquareIcon,
  SquareTerminalIcon,
  UsersIcon,
  XIcon,
} from "lucide-react";
import {
  agentSettingFields,
  planMode,
  ago,
  attentionInbox,
  attentionLabels,
  commandsFor,
  consoleSessions,
  densityLabels,
  draftOf,
  folderName,
  harnessLabels,
  inputImageTypes,
  inputImagesError,
  latestPlan,
  markSeen,
  placeApprovals,
  plainLine,
  recentFolders,
  saveDraft,
  sessionBlocks,
  sessionCommand,
  hitKindLabels,
  accountReady,
  useHostAccounts,
  useSessionSubagents,
  matchParts,
  useHistorySearch,
  sessionAccess,
  sessionMatches,
  ownComputers,
  sessionComputer,
  sessionName,
  shareChoice,
  shareLabels,
  sharedAs,
  delegatedBy,
  delegatedTo,
  sessionOutputAt,
  sessionState,
  useSeen,
  mentionAt,
  useSessionCommands,
  useSessionEvents,
  useSessionFiles,
  useSessionLive,
  useSessionQueue,
  useSessionUsage,
  useSessionGit,
  withMention,
  contextShare,
  percent,
  tokenCount,
  useSessionSettings,
  useVoice,
} from "@zerolux/chat";
import type {
  AgentSettings,
  Attention,
  Chat,
  ChatSession,
  Density,
  InputImage,
  InputMode,
  Perform,
  PlanStep,
  QueuedInput,
  Host,
  SentInput,
  SessionShare,
  SessionUsage,
  ShareChoice as ShareChoiceValue,
} from "@zerolux/chat";
import type { Actor } from "./api";
import { sessionTone } from "./presence";
import { Presence } from "@/components/presence";
import { SessionMark } from "@/components/profile";
import {
  InputBubble,
  LiveItems,
  SessionBlocks,
} from "@/components/session-blocks";
import { Listen } from "@/components/listen";
import { useReadAloud } from "./read-aloud";
import { PlanSteps } from "@/components/tool-call";
import { Reveal } from "@/components/reveal";
import { setDensity, useDensity } from "@/components/density";
import { Button, buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Toggle } from "@/components/ui/toggle";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  NativeSelect,
  NativeSelectOption,
} from "@/components/ui/native-select";
import { SessionCard, StartSession, resumable, takeable } from "./Team";
import { ApprovalCard, ApprovalReceipt } from "./Approvals";
import { sendsOnEnter } from "./ChatView";
import { useMe } from "./AuthGate";
import { ChangesPanel, FilesPanel, TerminalPanel } from "./SessionCode";
import { SubagentList, SubagentPanel } from "./SessionSubagents";

import { AskOnTheSide, InputActions } from "./SessionFork";
import { SessionSchedules } from "./SessionSchedules";
import { SessionTasks } from "./SessionTasks";
import { SessionTriggers } from "./SessionTriggers";
import { ContinueInTerminal } from "./ContinueInTerminal";
import { GoalCard } from "./SessionGoal";
import type { Fork } from "./SessionFork";
import type { CodePane } from "./SessionCode";
import { SidePanel } from "@/components/side-panel";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { XL, useMedia } from "./media";

const MAX_TEXT = 64 * 1024;

/** A picked image as the kernel takes it: its type and base64 bytes. */
const imageOf = (file: File) =>
  new Promise<InputImage>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () =>
      resolve({
        media_type: file.type,
        data: String(reader.result).split(",", 2)[1] ?? "",
      });
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });

const outputLine = (chat: Chat, session: ChatSession) => {
  const at = sessionOutputAt(chat, session);
  return at ? `Output ${ago(at)}` : undefined;
};

/** How each state reads in the inbox: what needs you stands out, the rest stays quiet. */
const attentionTones: Record<Attention, string> = {
  approval: "text-attention",
  input: "text-attention",
  working: "text-agent-foreground",
  failed: "text-destructive",
  unseen: "text-foreground",
  idle: "text-faint",
};

/** A choice among a few, side by side; the chosen one pressed. */
function Segmented<T extends string | boolean>({
  label,
  value,
  options,
  choose,
  className,
}: {
  label: string;
  value: T;
  options: readonly (readonly [T, ReactNode])[];
  choose: (value: T) => void;
  className?: string;
}) {
  return (
    <div
      role="group"
      aria-label={label}
      className={cn(
        "flex w-fit gap-0.5 rounded-sm border bg-background p-0.5",
        className,
      )}
    >
      {options.map(([option, text]) => (
        <button
          key={String(option)}
          type="button"
          aria-pressed={value === option}
          onClick={() => choose(option)}
          className="h-6 rounded-[3px] px-2.5 text-[12.5px] font-medium text-muted-foreground transition-colors hover:text-foreground aria-pressed:bg-secondary aria-pressed:text-foreground aria-pressed:shadow-[0_0_0_1px_var(--color-input)]"
        >
          {text}
        </button>
      ))}
    </div>
  );
}

type ListView = "live" | "stopped" | "archived";
const emptyLists: Record<ListView, string> = {
  live: "No live sessions.",
  stopped: "No stopped sessions.",
  archived: "Nothing archived.",
};

/**
 * The Agent Console's column, as an inbox: pinned sessions first, then each live session in
 * one state, what needs you first, the latest within each; stopped and archived on request.
 */
export function ConsoleList({
  chat,
  actors,
  starts = true,
  guestOn,
  hosts,
  busy,
  perform,
}: {
  chat: Chat;
  actors: Actor[];
  /** The workspace's computers: one's own joined ones run sessions too. */
  hosts?: Host[];
  /** Sessions start on this computer for its person, or for anyone it is open to. */
  starts?: boolean;
  /** The computer one is a guest on: one's sessions there need one's own accounts. */
  guestOn?: string;
  busy: boolean;
  perform: Perform;
}) {
  const { me } = useMe(actors);
  const [view, setView] = useState<ListView>("live");
  const [starting, setStarting] = useState(false);
  // One's own joined computers online: sessions start there too.
  const computers = ownComputers(hosts, me?.id);
  // A guest's sessions here run with their own accounts: one per harness, connected first.
  const { accounts: guestAccounts } = useHostAccounts(guestOn);
  // Every word typed is in the session's title, agent, folder, harness or latest line.
  const [query, setQuery] = useState("");
  const navigate = useNavigate();
  const seen = useSeen();
  const sessions = consoleSessions(
    query.trim()
      ? chat.sessions.filter((session) =>
          sessionMatches(session, actors, query.trim()),
        )
      : chat.sessions,
  );
  const shown = attentionInbox(
    sessions[view].map((session) => ({
      ...session,
      output_at: sessionOutputAt(chat, session) ?? null,
    })),
    chat.approvals,
    seen,
  );
  // Grouped only while live: pinned first, then by state.
  const group = (row: (typeof shown)[number]) =>
    view !== "live"
      ? undefined
      : row.session.pinned_at
        ? "pinned"
        : row.attention;
  return (
    <section aria-label="Console" className="flex min-h-0 flex-1 flex-col">
      <header className="flex items-center justify-between gap-2 px-4 pt-4 pb-3">
        <h2 className="text-lg font-semibold tracking-tight">Console</h2>
        {(starts || computers.length > 0) && (
          <Button size="sm" variant="outline" onClick={() => setStarting(true)}>
            <PlusIcon data-icon="inline-start" />
            New session
          </Button>
        )}
      </header>
      <Dialog open={starting} onOpenChange={setStarting}>
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>New session</DialogTitle>
          </DialogHeader>
          <StartSession
            chat={chat}
            actors={actors}
            folders={recentFolders(chat.sessions)}
            busy={busy}
            perform={perform}
            agent="none"
            here={starts}
            computers={computers}
            ready={
              guestOn
                ? (harness) => accountReady(guestAccounts, harness)
                : undefined
            }
            heading="New session"
            className="border-0 bg-transparent p-0 [&>div:first-child]:hidden"
            created={(session) => {
              setStarting(false);
              navigate(`/console/${session.id}`);
            }}
          />
        </DialogContent>
      </Dialog>
      <label className="mx-3 mb-2 flex items-center gap-2 rounded-md border border-input bg-background px-2.5 focus-within:border-ring">
        <SearchIcon aria-hidden className="size-3.5 shrink-0 text-faint" />
        <input
          type="search"
          aria-label="Find a session"
          placeholder="Find a session"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          className="h-8 min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-faint"
        />
      </label>
      <Segmented<ListView>
        label="Show"
        className="mx-3 mb-2"
        value={view}
        choose={setView}
        options={(
          [
            ["live", "Live", sessions.live.length],
            ["stopped", "Stopped", sessions.stopped.length],
            ["archived", "Archived", sessions.archived.length],
          ] as const
        ).map(([value, label, count]) => [
          value,
          <>
            {label}
            <span className="ml-1.5 font-mono text-[11px] text-faint">
              {count}
            </span>
          </>,
        ])}
      />
      <nav
        aria-label="Agent sessions"
        className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto px-2 pb-3"
      >
        {shown.map((row, i) => {
          const { session, attention } = row;
          const agent = actors.find((a) => a.id === session.actor_id);
          const tone = sessionTone(session);
          const heading = group(row);
          // A pending request says what it asks; otherwise the session's latest in a line.
          const asks = chat.approvals.find(
            (a) => a.session_id === session.id && a.status === "pending",
          );
          const line =
            attention === "working"
              ? sessionState(session)
              : asks
                ? `Asks: ${asks.summary}`
                : (session.summary && plainLine(session.summary)) ||
                  (agent ? session.title : folderName(session.workspace)) ||
                  "Untitled session";
          return (
            <div key={session.id} className="flex flex-col">
              {heading && (i === 0 || group(shown[i - 1]!) !== heading) && (
                <h3
                  className={cn(
                    "flex items-center justify-between px-2 pt-3 pb-1 font-mono text-[11px] tracking-wide uppercase",
                    heading === "pinned"
                      ? "text-muted-foreground"
                      : attentionTones[heading],
                  )}
                >
                  {heading === "pinned" ? "Pinned" : attentionLabels[heading]}
                  <span className="text-faint">
                    {shown.filter((s) => group(s) === heading).length}
                  </span>
                </h3>
              )}
              <NavLink
                to={`/console/${session.id}`}
                className="flex items-center gap-3 rounded-md px-2 py-2.5 transition-colors hover:bg-accent aria-[current=page]:bg-accent"
              >
                <SessionMark
                  session={session}
                  actors={actors}
                  state={tone}
                  className="size-8"
                />
                <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className="flex items-baseline gap-2">
                    <span
                      className={cn(
                        "truncate text-sm",
                        agent
                          ? "font-mono text-agent-foreground"
                          : "font-medium",
                      )}
                    >
                      {sessionName(session, actors)}
                    </span>
                    <span className="shrink-0 font-mono text-[11px] text-faint">
                      {harnessLabels[session.harness] ?? session.harness}
                    </span>
                    {/* Shared: with everyone, to read or to work in; someone else's, by whom. */}
                    {session.shared && (
                      <UsersIcon
                        aria-label={`Shared to ${session.shared}`}
                        className="size-3 shrink-0 text-faint"
                      />
                    )}
                    {sessionComputer(session, hosts) && (
                      <span className="truncate font-mono text-[11px] text-faint">
                        on {sessionComputer(session, hosts)!.name}
                      </span>
                    )}
                    {session.owner_id !== me?.id && (
                      <span className="truncate font-mono text-[11px] text-faint">
                        by{" "}
                        {actors.find((a) => a.id === session.owner_id)?.name ??
                          "someone"}
                      </span>
                    )}
                    {session.output_at && (
                      <span className="ml-auto shrink-0 font-mono text-[11px] text-faint">
                        {ago(session.output_at)}
                      </span>
                    )}
                  </span>
                  <span
                    className={cn(
                      "flex items-center gap-1.5 truncate text-[13px] text-muted-foreground",
                      attention === "working" && "text-agent-foreground",
                      asks && "text-attention",
                      attention === "unseen" && "font-medium text-foreground",
                    )}
                  >
                    {attention === "unseen" && (
                      <span
                        aria-hidden
                        className="size-1.5 shrink-0 rounded-full bg-agent"
                      />
                    )}
                    {row.session.parent_session_id && (
                      <span className="shrink-0 font-mono text-[11px] text-faint">
                        ↳{" "}
                        {sessionName(
                          delegatedBy(row.session, chat.sessions) ??
                            row.session,
                          actors,
                        )}
                      </span>
                    )}
                    <span className="truncate">{line}</span>
                  </span>
                </span>
              </NavLink>
            </div>
          );
        })}
        {shown.length === 0 && (
          <p className="px-2 py-6 text-sm text-faint">
            {query.trim() ? "No session matches." : emptyLists[view]}
          </p>
        )}
        <HistoryHits query={query} chat={chat} actors={actors} />
      </nav>
    </section>
  );
}

/** The console with no session chosen yet. */
export function ConsoleHome({ chat }: { chat: Chat }) {
  const { live } = consoleSessions(chat.sessions);
  const working = live.filter((s) => sessionTone(s) === "working").length;
  return (
    <div className="flex flex-col gap-2">
      <h1 className="text-2xl font-semibold tracking-tight">Agent console.</h1>
      <p className="text-sm text-muted-foreground">
        {live.length
          ? `${live.length} live${working ? ` · ${working} working` : ""}`
          : "No live sessions."}
      </p>
    </div>
  );
}

/** One session: who and where, its work in the middle, and a box to steer it. */
export function SessionView({
  session,
  chat,
  actors,
  hosts,
  busy,
  perform,
}: {
  session: ChatSession;
  chat: Chat;
  actors: Actor[];
  /** The workspace's computers: a session on a joined one is reached through its link. */
  hosts?: Host[];
  busy: boolean;
  perform: Perform;
}) {
  // The joined computer it runs on, if one: About says which and whether it is online.
  const computer = sessionComputer(session, hosts);
  const name = sessionName(session, actors);
  const agent = actors.find((a) => a.id === session.actor_id);
  const tone = sessionTone(session);
  const working = tone === "working";
  const { me } = useMe(actors);
  // Its person does everything; shared to write, one works in it too; to read, one follows it.
  const access = sessionAccess(session, me?.id);
  // The agent's words, heard in its own voice where it has one.
  const voice = useVoice();
  const aloud = useReadAloud();
  const speaker = voice.voices?.some((v) => v.actor_id === session.actor_id)
    ? session.actor_id
    : undefined;
  const [about, setAbout] = useState(false);
  // The new title while renaming.
  const [title, setTitle] = useState<string>();
  async function rename(event: React.FormEvent) {
    event.preventDefault();
    const next = title?.trim();
    if (
      next &&
      (await perform(() => chat.updateSession(session.id, { title: next })))
    )
      setTitle(undefined);
  }
  const { events, error, more, earlier } = useSessionEvents(
    session.id,
    chat.outputs[session.id]?.end,
  );
  const blocks = sessionBlocks(events);
  // What it produces before its record has it, after the recorded work.
  const live = useSessionLive(session.id, chat.live, events.length);
  // The owner's inputs waiting for the turn to end, as the harness queues them.
  const queue = useSessionQueue(session.id, chat.live);
  // The owner's inputs on their way, until the record or the queue has them.
  const sent = chat.sentInputs(session.id, blocks, queue);
  // How full its context is and what it has used, as its harness last said.
  const usage = useSessionUsage(session.id, chat.live);
  const plan = latestPlan(blocks);
  const density = useDensity();
  const at = sessionOutputAt(chat, session);
  // Its code, for its owner: what git sees, read again as the session writes; the panel open.
  const git = useSessionGit(access.read ? session.id : undefined, at);
  const changed = git.status?.changes.length ?? 0;
  const [pane, setPane] = useState<CodePane>();
  // The subagents it started, each with work of its own to open beside its own.
  const { subagents = [] } = useSessionSubagents(session.id, at);
  const [shownSubagent, setShownSubagent] = useState<string>();
  const subagent = subagents.find((s) => s.id === shownSubagent);
  const openSubagent = (id: string) => {
    setShownSubagent(id);
    setPane("subagent");
  };
  // The session that started this one, and those this one started, to delegate work.
  const parent = delegatedBy(session, chat.sessions);
  const delegates = delegatedTo(session.id, chat.sessions);
  // A new session from this one, whole or before an input, with the owner's words, opened.
  const navigate = useNavigate();
  const [asking, setAsking] = useState(false);
  // Its own terminal: for its person, on a computer of theirs.
  const [continuing, setContinuing] = useState(false);
  const ownComputer =
    !session.host_id ||
    !hosts ||
    hosts.some((h) => h.id === session.host_id && h.person_id === me?.id);
  const fork: Fork = (at, text) =>
    perform(async () => {
      const { session: forked } = await chat.forkSession(
        session.id,
        at === undefined ? {} : { at },
      );
      if (text) await chat.input(forked.id, text);
      navigate(`/console/${forked.id}`);
    });
  const wide = useMedia(XL);
  const toggle = (next: CodePane) => setPane(pane === next ? undefined : next);
  // Notes on lines go to the session as input: for those who may write to it.
  const note = access.write
    ? (text: string) => chat.input(session.id, text)
    : undefined;
  const chatTitle = (id: string | null) =>
    chat.conversations.find((c) => c.id === id)?.title;
  const code =
    access.read &&
    (pane === "changes" ? (
      <ChangesPanel
        session={session}
        name={name}
        git={git}
        revision={at}
        busy={busy}
        perform={perform}
        send={note}
        act={access.write}
        close={() => setPane(undefined)}
      />
    ) : pane === "files" ? (
      <FilesPanel
        session={session}
        name={name}
        revision={at}
        busy={busy}
        perform={perform}
        send={note}
        close={() => setPane(undefined)}
      />
    ) : pane === "subagent" && subagent ? (
      <SubagentPanel
        session={session}
        subagent={subagent}
        grown={chat.outputs[session.id]?.end}
        chatTitle={chatTitle}
        close={() => setPane(undefined)}
      />
    ) : pane === "terminal" && access.write ? (
      <TerminalPanel
        session={session}
        perform={perform}
        close={() => setPane(undefined)}
      />
    ) : undefined);
  useEffect(() => {
    if (!at) return;
    // What it wrote while you look at it is seen; while the window is hidden, it waits.
    const look = () => {
      if (document.visibilityState === "visible") markSeen(session.id, at);
    };
    look();
    document.addEventListener("visibilitychange", look);
    return () => document.removeEventListener("visibilitychange", look);
  }, [session.id, at]);
  const scroller = useRef<HTMLDivElement>(null);
  // A link to a point of its work (`?at=`, from a search) opens there, not at the bottom.
  const [params] = useSearchParams();
  const target = params.get("at");
  // New work follows at the bottom, as in a chat, while you are there.
  const following = useRef(target === null);
  // Earlier work comes in above: the distance from the bottom keeps your place.
  const fromBottom = useRef<number>(undefined);
  const top = useRef<number>(undefined);
  useLayoutEffect(() => {
    const view = scroller.current;
    if (!view) return;
    const earlierCame = events[0]?.at !== top.current;
    top.current = events[0]?.at;
    if (earlierCame && fromBottom.current !== undefined) {
      view.scrollTop = view.scrollHeight - fromBottom.current;
      fromBottom.current = undefined;
    } else if (following.current) view.scrollTop = view.scrollHeight;
  }, [events, live]);
  // Earlier work is read until the point is in; then it is shown, marked for a moment.
  const reached = useRef<string>(undefined);
  useEffect(() => {
    if (target === null || reached.current === target || !events.length) return;
    const at = Number(target);
    if (events[0]!.at > at && more) return void earlier();
    const place = scroller.current?.querySelector<HTMLElement>(
      `[data-at="${at}"]`,
    );
    if (!place) return;
    reached.current = target;
    following.current = false;
    place.scrollIntoView({ block: "center" });
    place.classList.add("rounded-md", "ring-2", "ring-primary/60");
    setTimeout(
      () => place.classList.remove("rounded-md", "ring-2", "ring-primary/60"),
      2500,
    );
  }, [target, events, more, earlier]);
  const interrupt = () =>
    void perform(async () => void (await chat.interrupt(session.id)));
  useEffect(() => {
    if (!working || !access.write) return;
    // Esc stops the turn, as in the harness itself, unless a dialog or menu takes it.
    const stop = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      if ((event.target as Element).closest?.("[role=dialog],[role=menu]"))
        return;
      interrupt();
    };
    window.addEventListener("keydown", stop);
    return () => window.removeEventListener("keydown", stop);
    // The session and its working state decide; interrupt reads them.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.id, working, access.write]);
  return (
    <>
      <SidePanel
        id="session-code"
        wide={wide}
        panel={wide && code}
        size={520}
        min={340}
        max={1000}
        className="flex min-h-0 min-w-0 flex-1"
      >
        <section
          aria-label={`${name}'s session`}
          className="@container flex min-h-0 min-w-0 flex-1 flex-col"
        >
          <header className="flex min-h-14 shrink-0 items-center gap-3 border-b px-3 py-2 md:px-5">
            <Link
              to="/console"
              aria-label="All sessions"
              className={buttonVariants({
                variant: "ghost",
                size: "icon-sm",
                className: "md:hidden",
              })}
            >
              <ChevronLeftIcon />
            </Link>
            <SessionMark
              session={session}
              actors={actors}
              state={tone}
              className="size-8"
            />
            <div className="min-w-0 flex-1">
              {title !== undefined ? (
                <form className="flex gap-2" onSubmit={(e) => void rename(e)}>
                  <Input
                    aria-label="Session title"
                    value={title}
                    onChange={(e) => setTitle(e.target.value)}
                    maxLength={200}
                    autoFocus
                    className="h-7"
                  />
                  <Button
                    type="submit"
                    size="sm"
                    disabled={busy || !title.trim()}
                  >
                    Save
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() => setTitle(undefined)}
                  >
                    Cancel
                  </Button>
                </form>
              ) : agent ? (
                <h2 className="truncate font-mono text-[15px] font-medium text-agent-foreground">
                  {name}
                  <span className="font-sans text-faint">
                    {" "}
                    · {session.title || "Untitled session"}
                  </span>
                </h2>
              ) : (
                <h2 className="truncate text-[15px] font-medium">{name}</h2>
              )}
              <p className="truncate text-xs text-muted-foreground">
                {sessionState(session)} ·{" "}
                {harnessLabels[session.harness] ?? session.harness} ·{" "}
                <span title={session.workspace} className="font-mono">
                  {folderName(session.workspace)}
                </span>
              </p>
            </div>
            {/* The pane's own width decides what the header has room for: the agent and the
                session's title always stay. */}
            <Presence tone={tone} className="@max-6xl:hidden">
              {outputLine(chat, session) ?? sessionState(session)}
            </Presence>
            <Segmented<Density>
              label="Density"
              className="@max-3xl:hidden"
              value={density}
              choose={setDensity}
              options={Object.entries(densityLabels) as [Density, string][]}
            />
            {access.read && (
              <>
                <Button
                  variant="outline"
                  size="sm"
                  aria-pressed={pane === "changes"}
                  title="Changes"
                  onClick={() => toggle("changes")}
                  className="aria-pressed:bg-accent"
                >
                  <GitCompareArrowsIcon data-icon="inline-start" />
                  <span className="@max-5xl:sr-only">Changes</span>
                  {changed > 0 && (
                    <span className="font-mono text-[11px] text-attention">
                      {changed}
                    </span>
                  )}
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  aria-pressed={pane === "files"}
                  title="Files"
                  onClick={() => toggle("files")}
                  className="aria-pressed:bg-accent"
                >
                  <FileSearchIcon data-icon="inline-start" />
                  <span className="@max-5xl:sr-only">Files</span>
                </Button>
                {access.write && (
                  <Button
                    variant="outline"
                    size="sm"
                    aria-pressed={pane === "terminal"}
                    title="Terminal"
                    onClick={() => toggle("terminal")}
                    className="aria-pressed:bg-accent"
                  >
                    <SquareTerminalIcon data-icon="inline-start" />
                    <span className="@max-5xl:sr-only">Terminal</span>
                  </Button>
                )}
              </>
            )}
            <Button
              variant="outline"
              size="sm"
              aria-expanded={about}
              title="About this session"
              onClick={() => setAbout(!about)}
            >
              <InfoIcon data-icon="inline-start" />
              <span className="@max-5xl:sr-only">About this session</span>
            </Button>
            {access.mine && (
              <DropdownMenu>
                <DropdownMenuTrigger
                  render={
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label="Session actions"
                    />
                  }
                >
                  <EllipsisIcon />
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-48">
                  <DropdownMenuItem onClick={() => setTitle(session.title)}>
                    <PencilIcon />
                    Rename
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    onClick={() =>
                      void perform(() =>
                        chat.updateSession(session.id, {
                          pinned: !session.pinned_at,
                        }),
                      )
                    }
                  >
                    {session.pinned_at ? <PinOffIcon /> : <PinIcon />}
                    {session.pinned_at ? "Unpin" : "Pin"}
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    onClick={() =>
                      void perform(() =>
                        chat.updateSession(session.id, {
                          archived: !session.archived_at,
                        }),
                      )
                    }
                  >
                    {session.archived_at ? (
                      <ArchiveRestoreIcon />
                    ) : (
                      <ArchiveIcon />
                    )}
                    {session.archived_at ? "Unarchive" : "Archive"}
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => void fork()}>
                    <GitForkIcon />
                    Fork
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => setAsking(true)}>
                    <MessageCircleQuestionIcon />
                    Ask on the side…
                  </DropdownMenuItem>
                  {ownComputer && (
                    <DropdownMenuItem onClick={() => setContinuing(true)}>
                      <SquareTerminalIcon />
                      Continue in terminal…
                    </DropdownMenuItem>
                  )}
                </DropdownMenuContent>
              </DropdownMenu>
            )}
          </header>
          <div
            ref={scroller}
            className="min-h-0 flex-1 overflow-y-auto px-3 py-4 md:px-6"
            onScroll={(event) => {
              const view = event.currentTarget;
              following.current =
                view.scrollHeight - view.scrollTop - view.clientHeight < 80;
            }}
          >
            <div className="mx-auto flex max-w-3xl flex-col gap-3">
              {about && (
                <SessionCard
                  session={session}
                  name={name}
                  facts
                  usage={usage}
                  computer={
                    computer &&
                    `${computer.name} · ${computer.online ? "online" : "offline"}`
                  }
                  delegatedBy={
                    parent && (
                      <Link
                        to={`/console/${parent.id}`}
                        className="underline-offset-4 hover:underline"
                      >
                        {sessionName(parent, actors)}
                      </Link>
                    )
                  }
                  // Codex reports no cost: a budget there would never be reached.
                  budget={
                    access.mine && session.harness !== "codex"
                      ? (usd) =>
                          perform(() =>
                            chat.updateSession(session.id, { budget_usd: usd }),
                          )
                      : undefined
                  }
                  busy={busy}
                  stop={
                    access.write
                      ? () => perform(() => chat.stop(session.id))
                      : undefined
                  }
                  resume={
                    access.write && resumable(session)
                      ? () => perform(() => chat.resume(session.id))
                      : undefined
                  }
                  takeover={
                    access.mine && takeable(session)
                      ? () => perform(() => chat.takeoverPi(session.id))
                      : undefined
                  }
                />
              )}
              {about && access.mine && (
                <ShareChoice
                  session={session}
                  busy={busy}
                  share={(shared) =>
                    perform(() => chat.updateSession(session.id, { shared }))
                  }
                />
              )}
              {about && subagents.length > 0 && (
                <SubagentList subagents={subagents} open={openSubagent} />
              )}
              {about && delegates.length > 0 && (
                <DelegatedSessions sessions={delegates} actors={actors} />
              )}
              {about && session.harness === "codex" && (
                <GoalCard
                  session={session}
                  read={chat.live}
                  write={access.write}
                  busy={busy}
                  perform={perform}
                />
              )}
              {about && (
                <SessionTasks
                  session={session}
                  write={access.write}
                  busy={busy}
                  perform={perform}
                />
              )}
              {about && access.write && (
                <SessionSchedules
                  session={session}
                  busy={busy}
                  perform={perform}
                />
              )}
              {about && access.write && (
                <SessionTriggers
                  session={session}
                  revision={at}
                  busy={busy}
                  perform={perform}
                />
              )}
              {more && (
                <Button
                  variant="outline"
                  size="sm"
                  className="self-center"
                  onClick={() => {
                    const view = scroller.current;
                    if (view)
                      fromBottom.current = view.scrollHeight - view.scrollTop;
                    earlier();
                  }}
                >
                  Show earlier work
                </Button>
              )}
              <SessionBlocks
                blocks={placeApprovals(
                  blocks,
                  chat.approvals.filter((a) => a.session_id === session.id),
                )}
                chatTitle={chatTitle}
                openSubagent={(toolCallId) => {
                  const started = subagents.find(
                    (s) => s.tool_call_id === toolCallId,
                  );
                  return started && (() => openSubagent(started.id));
                }}
                textActions={
                  speaker
                    ? (text) => (
                        <Listen
                          reading={aloud.reading === text.key}
                          error={
                            aloud.failed?.id === text.key
                              ? aloud.failed.error
                              : undefined
                          }
                          toggle={() =>
                            aloud.reading === text.key
                              ? aloud.stop()
                              : void aloud.read(text.key, speaker, text.text)
                          }
                        />
                      )
                    : undefined
                }
                inputActions={
                  access.write
                    ? (input) => (
                        <InputActions
                          input={input}
                          // A fork is its person's; rewinding works the session's files.
                          fork={access.mine ? fork : undefined}
                          // Claude Code keeps checkpoints of the files; the others do not.
                          rewind={
                            session.harness === "claude-code"
                              ? (at, dryRun) =>
                                  chat.rewindFiles(session.id, at, dryRun)
                              : undefined
                          }
                          busy={busy}
                          perform={perform}
                        />
                      )
                    : undefined
                }
                renderApproval={(approval) =>
                  approval.status === "pending" ? (
                    <ApprovalCard
                      approval={approval}
                      chat={chat}
                      actors={actors}
                      busy={busy}
                      perform={perform}
                    />
                  ) : (
                    <ApprovalReceipt approval={approval} />
                  )
                }
              />
              {sent.map((input) => (
                <SentInputBubble
                  key={input.id}
                  input={input}
                  retry={() => void chat.retryInput(input.id).catch(() => {})}
                  drop={() => chat.dropInput(input.id)}
                />
              ))}
              <LiveItems items={live} />
              {!blocks.length && !live.length && !sent.length && !error && (
                <p className="text-sm text-faint">Nothing recorded yet.</p>
              )}
              {error && (
                <p role="alert" className="text-sm text-destructive">
                  {error}
                </p>
              )}
            </div>
          </div>
          <SessionInput
            key={session.id}
            session={session}
            name={name}
            owner={access.write}
            working={working}
            busy={busy}
            perform={perform}
            send={(text, mode, images) =>
              chat.input(
                session.id,
                text,
                mode,
                images,
                events.length ? events[events.length - 1]!.at + 1 : undefined,
              )
            }
            compact={(instructions) => chat.compact(session.id, instructions)}
            interrupt={interrupt}
            usage={usage}
          >
            {plan?.some((step) => step.status !== "done") && (
              <PlanBar steps={plan} />
            )}
            {queue.length > 0 && (
              <QueueCards
                queue={queue}
                busy={busy}
                // Codex lets a waiting input change; the other harnesses only show it.
                change={
                  access.write && session.harness === "codex"
                    ? {
                        remove: (item) =>
                          perform(() => chat.removeQueued(session.id, item.id)),
                        edit: (item, text) =>
                          perform(() =>
                            chat.editQueued(session.id, item.id, text),
                          ),
                      }
                    : undefined
                }
              />
            )}
          </SessionInput>
        </section>
      </SidePanel>
      <AskOnTheSide
        open={asking}
        close={() => setAsking(false)}
        fork={fork}
        busy={busy}
      />
      <ContinueInTerminal
        session={session}
        hosts={hosts}
        open={continuing}
        close={() => setContinuing(false)}
        stop={() => chat.stop(session.id)}
        busy={busy}
        perform={perform}
      />
      {!wide && (
        <Sheet
          open={!!code}
          onOpenChange={(open) => !open && setPane(undefined)}
        >
          <SheetContent
            side="right"
            showCloseButton={false}
            className="gap-0 p-0 data-[side=right]:w-full data-[side=right]:sm:max-w-2xl"
          >
            <SheetTitle className="sr-only">
              {pane === "terminal"
                ? "Terminal"
                : pane === "files"
                  ? "Files"
                  : "Changes"}
            </SheetTitle>
            {code}
          </SheetContent>
        </Sheet>
      )}
    </>
  );
}

/** The words searched, as they stand out in a match's text. */
export function Marked({ text, query }: { text: string; query: string }) {
  return matchParts(text, query).map((part, i) =>
    part.match ? (
      <mark key={i} className="rounded-xs bg-primary/25 text-foreground">
        {part.text}
      </mark>
    ) : (
      part.text
    ),
  );
}

/**
 * What the sessions said and did that matches what is typed, the latest first: each opens its
 * session at that point.
 */
function HistoryHits({
  query,
  chat,
  actors,
}: {
  query: string;
  chat: Chat;
  actors: Actor[];
}) {
  const { results, truncated, error, searching } = useHistorySearch(query);
  if (query.trim().length < 2) return null;
  return (
    <section aria-label="In their history" className="flex flex-col gap-0.5">
      <h3 className="flex items-center justify-between px-2 pt-3 pb-1 font-mono text-[11px] tracking-wide text-faint uppercase">
        In their history
        <span>{searching ? "…" : (results?.length ?? 0)}</span>
      </h3>
      {error && <p className="px-2 text-xs text-attention">{error}</p>}
      {results?.length === 0 && (
        <p className="px-2 py-2 text-sm text-faint">No matches.</p>
      )}
      {results?.map((hit) => {
        const session = chat.sessions.find((s) => s.id === hit.session_id);
        return (
          <Link
            key={`${hit.session_id}:${hit.at}:${hit.kind}`}
            to={`/console/${hit.session_id}?at=${hit.at}`}
            className="flex flex-col gap-0.5 rounded-md px-2 py-2 transition-colors hover:bg-accent"
          >
            <span className="flex items-baseline gap-2">
              <span className="truncate text-sm font-medium">
                {session ? sessionName(session, actors) : hit.title}
              </span>
              <span className="shrink-0 font-mono text-[11px] text-faint">
                {hitKindLabels[hit.kind]}
              </span>
              {hit.time && (
                <span className="ml-auto shrink-0 font-mono text-[11px] text-faint">
                  {ago(Date.parse(hit.time))}
                </span>
              )}
            </span>
            <span className="line-clamp-2 text-[13px] text-muted-foreground">
              <Marked text={hit.snippet} query={query} />
            </span>
          </Link>
        );
      })}
      {truncated && (
        <p className="px-2 text-xs text-faint">Not all history was searched.</p>
      )}
    </section>
  );
}

/**
 * Who else in the workspace sees the session: nobody, everyone to follow it, or everyone to
 * work in it too, with native input as its person's.
 */
function ShareChoice({
  session,
  busy,
  share,
}: {
  session: ChatSession;
  busy: boolean;
  share: (shared: SessionShare) => Promise<boolean>;
}) {
  const choice = shareChoice(session.shared);
  return (
    <section
      aria-label="Share"
      className="flex flex-wrap items-center gap-3 rounded-lg border p-3"
    >
      <h3 className="text-sm font-medium">Share</h3>
      <Segmented<ShareChoiceValue>
        label="Shared with the workspace"
        value={choice}
        choose={(next) => {
          if (!busy && next !== choice) void share(sharedAs(next));
        }}
        options={Object.entries(shareLabels) as [ShareChoiceValue, string][]}
      />
    </section>
  );
}

/** The sessions this one started to delegate work to, each with its state, to open. */
function DelegatedSessions({
  sessions,
  actors,
}: {
  sessions: ChatSession[];
  actors: Actor[];
}) {
  return (
    <section
      aria-label="Delegated"
      className="flex flex-col gap-2 rounded-lg border p-3"
    >
      <h3 className="text-sm font-medium">
        Delegated
        <span className="ml-1.5 font-mono text-[11px] text-faint">
          {sessions.length}
        </span>
      </h3>
      <ul className="flex flex-col">
        {sessions.map((delegate) => (
          <li key={delegate.id}>
            <Link
              to={`/console/${delegate.id}`}
              className="flex items-center gap-3 rounded-md px-1.5 py-1.5 transition-colors hover:bg-accent"
            >
              <SessionMark
                session={delegate}
                actors={actors}
                state={sessionTone(delegate)}
                className="size-6 text-[10px]"
              />
              <span className="min-w-0 flex-1 truncate text-sm">
                {sessionName(delegate, actors)}
              </span>
              <span className="shrink-0 font-mono text-[11px] text-faint">
                {sessionState(delegate)}
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}

/**
 * The owner's own words, straight into the session: a new turn when idle, joining the running
 * one otherwise. While it works and nothing is written, the button interrupts instead.
 */
function SessionInput({
  session,
  name,
  owner,
  working,
  busy,
  perform,
  send,
  compact,
  interrupt,
  usage,
  children,
}: {
  session: ChatSession;
  name: string;
  owner: boolean;
  working: boolean;
  busy: boolean;
  perform: Perform;
  send: (text: string, mode: InputMode, images: InputImage[]) => Promise<void>;
  /** `/compact [instructions]`: the harness's own compaction, as in its terminal. */
  compact: (instructions: string) => Promise<void>;
  interrupt: () => void;
  usage: SessionUsage | null;
  /** What stays above the box while the session works, as its plan. */
  children?: ReactNode;
}) {
  // Unsent words stay with their session, as a chat keeps its draft.
  const [text, setText] = useState(() => draftOf(session.id));
  const write = (next: string) => {
    setText(next);
    saveDraft(session.id, next);
  };
  const box = useRef<HTMLTextAreaElement>(null);
  const open = owner && session.status === "connected";
  const tooLong = new TextEncoder().encode(text).length > MAX_TEXT;
  // Images going with the next input, shown by object URLs freed once they go.
  const [picked, setPicked] = useState<{ file: File; url: string }[]>([]);
  const shown = useRef(picked);
  shown.current = picked;
  useEffect(
    () => () => shown.current.forEach(({ url }) => URL.revokeObjectURL(url)),
    [],
  );
  const imagesError = inputImagesError(picked.map(({ file }) => file));
  const picker = useRef<HTMLInputElement>(null);
  const add = (from: Iterable<File>) => {
    const images = [...from].filter((file) => file.type.startsWith("image/"));
    if (images.length)
      setPicked((all) => [
        ...all,
        ...images.map((file) => ({ file, url: URL.createObjectURL(file) })),
      ]);
  };
  const remove = (url: string) => {
    URL.revokeObjectURL(url);
    setPicked((all) => all.filter((image) => image.url !== url));
  };
  const empty = !text.trim() && !picked.length;
  const stops = owner && working && empty;
  // ZeroLux's commands and the harness's own while one is typed; files after "@".
  const command = sessionCommand(text);
  const harness = useSessionCommands(session.id);
  const [cursor, setCursor] = useState(text.length);
  const mention = open ? mentionAt(text, cursor) : undefined;
  const files = useSessionFiles(session.id, mention?.query);
  const [chosen, setChosen] = useState(0);
  // Esc closes the list until the text changes, and only then interrupts.
  const [dismissed, setDismissed] = useState(false);
  const place = (next: string, at: number) => {
    write(next);
    setChosen(0);
    setDismissed(false);
    setCursor(at);
    requestAnimationFrame(() => {
      box.current?.focus();
      box.current?.setSelectionRange(at, at);
    });
  };
  const suggestions: {
    key: string;
    label: ReactNode;
    description?: string;
    /** Typed in full already: Enter runs it instead of completing it. */
    whole?: boolean;
    take: () => void;
  }[] = dismissed
    ? []
    : mention
      ? files.map((path) => ({
          key: path,
          label: path,
          take: () => {
            const next = withMention(text, mention, path);
            place(next.text, next.cursor);
          },
        }))
      : (open ? commandsFor(text, harness) : []).map((offer) => ({
          key: offer.invoke,
          label: (
            <>
              {offer.invoke}
              {offer.hint && <span className="text-faint"> {offer.hint}</span>}
            </>
          ),
          description: offer.description,
          whole: offer.invoke.toLowerCase() === text.trim().toLowerCase(),
          take: () => place(`${offer.invoke} `, offer.invoke.length + 1),
        }));
  const highlighted = suggestions[Math.min(chosen, suggestions.length - 1)];
  // Claude Code in a terminal only takes words into the running turn, without images.
  const modes = !(
    session.harness === "claude-code" && session.origin !== "owned"
  );
  async function submit(mode: InputMode = "steer") {
    if (!open || empty || tooLong || imagesError) return;
    const sent = text;
    const run = sessionCommand(sent);
    const going = run ? [] : picked;
    const done = await perform(async () => {
      if (run?.name === "compact") return compact(run.args);
      const images = await Promise.all(going.map(({ file }) => imageOf(file)));
      // It shows below at once, and a failure there, to send again.
      void send(sent.trim(), working ? mode : "steer", images).catch(() => {});
    });
    if (!done) return;
    going.forEach(({ url }) => remove(url));
    // What was typed meanwhile stays.
    if (draftOf(session.id) === sent) write("");
    if (box.current) box.current.style.height = "auto";
  }
  return (
    <form
      className="flex flex-col gap-1.5 border-t px-3 pt-3 pb-2 md:px-5"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
      onDragOver={(event) => {
        if (modes && open && event.dataTransfer.types.includes("Files"))
          event.preventDefault();
      }}
      onDrop={(event) => {
        if (!modes || !open) return;
        event.preventDefault();
        add(event.dataTransfer.files);
      }}
    >
      {children}
      {suggestions.length > 0 && (
        <div
          role="group"
          aria-label={mention ? "Files" : "Commands"}
          className="mx-auto max-h-64 w-full max-w-3xl overflow-y-auto rounded-md border bg-popover text-sm shadow-sm"
        >
          {suggestions.map((suggestion) => (
            <button
              key={suggestion.key}
              type="button"
              aria-current={suggestion === highlighted || undefined}
              onClick={suggestion.take}
              className="flex w-full items-baseline gap-3 px-3 py-2 text-left transition-colors outline-none hover:bg-accent focus-visible:bg-accent aria-[current]:bg-accent"
            >
              <span
                className={cn(
                  "font-mono text-[13px]",
                  suggestion.description ? "shrink-0" : "truncate",
                )}
              >
                {suggestion.label}
              </span>
              {suggestion.description && (
                <span className="truncate text-muted-foreground">
                  {suggestion.description}
                </span>
              )}
            </button>
          ))}
        </div>
      )}
      {picked.length > 0 && (
        <ul
          aria-label="Images to send"
          className="mx-auto flex w-full max-w-3xl flex-wrap gap-2"
        >
          {picked.map(({ file, url }) => (
            <li key={url} className="relative">
              <img
                src={url}
                alt={file.name}
                className="size-14 rounded-md border object-cover"
              />
              <button
                type="button"
                aria-label={`Remove ${file.name}`}
                onClick={() => remove(url)}
                className="absolute -top-1.5 -right-1.5 grid size-5 place-items-center rounded-full border bg-background text-muted-foreground transition-colors hover:text-foreground"
              >
                <XIcon className="size-3" />
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="mx-auto flex w-full max-w-3xl items-end gap-2">
        {modes && (
          <>
            <input
              ref={picker}
              type="file"
              accept={inputImageTypes.join(",")}
              multiple
              hidden
              onChange={(event) => {
                add(event.target.files ?? []);
                event.target.value = "";
              }}
            />
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="h-10.5 w-10"
              aria-label="Add images"
              title="Add images"
              disabled={!open}
              onClick={() => picker.current?.click()}
            >
              <ImagePlusIcon />
            </Button>
          </>
        )}
        <textarea
          ref={box}
          aria-label={`Write to ${name}`}
          rows={1}
          value={text}
          disabled={!open}
          placeholder={
            !owner
              ? "Read only"
              : open
                ? working
                  ? `Add to ${name}'s turn`
                  : `Write to ${name}`
                : sessionState(session)
          }
          onChange={(event) => {
            // Grows with the text, up to a few lines; then it scrolls.
            event.target.style.height = "auto";
            event.target.style.height = `${event.target.scrollHeight}px`;
            write(event.target.value);
            setCursor(event.target.selectionStart);
            setChosen(0);
            setDismissed(false);
          }}
          onSelect={(event) => setCursor(event.currentTarget.selectionStart)}
          onPaste={(event) => {
            const pasted = [...event.clipboardData.files].filter((file) =>
              file.type.startsWith("image/"),
            );
            if (!modes || !pasted.length) return;
            event.preventDefault();
            add(pasted);
          }}
          onKeyDown={(event) => {
            // While a list is shown: arrows move, Tab or Enter takes the one shown.
            if (highlighted) {
              if (event.key === "Escape") {
                event.preventDefault();
                setDismissed(true);
                return;
              }
              if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                event.preventDefault();
                const step = event.key === "ArrowDown" ? 1 : -1;
                setChosen(
                  (suggestions.indexOf(highlighted) +
                    step +
                    suggestions.length) %
                    suggestions.length,
                );
                return;
              }
              // Enter on a command already typed in full runs it, as a terminal does.
              if (
                event.key === "Tab" ||
                (sendsOnEnter(event.nativeEvent) && !highlighted.whole)
              ) {
                event.preventDefault();
                highlighted.take();
                return;
              }
            }
            if (!sendsOnEnter(event.nativeEvent)) return;
            event.preventDefault();
            // Option Enter waits for the turn to end, as Queue does.
            void submit(event.altKey && working && modes ? "queue" : "steer");
          }}
          className="max-h-40 min-h-10.5 flex-1 resize-none rounded-md border border-input bg-background px-3 py-2.5 text-sm transition-[border-color,box-shadow] outline-none placeholder:text-faint focus:border-ring focus:ring-3 focus:ring-ring/20 disabled:opacity-60"
        />
        {stops ? (
          <Button
            type="button"
            variant="outline"
            className="h-10.5"
            disabled={busy}
            title="Interrupt (Esc)"
            onClick={interrupt}
          >
            <SquareIcon data-icon="inline-start" />
            Interrupt
          </Button>
        ) : (
          <div className="flex">
            <Button
              type="submit"
              disabled={busy || !open || empty || tooLong || !!imagesError}
              className={cn("h-10.5", working && modes && "rounded-r-none")}
            >
              Send
              <SendIcon data-icon="inline-end" />
            </Button>
            {working && modes && (
              <DropdownMenu>
                <DropdownMenuTrigger
                  disabled={busy || !open || empty || tooLong || !!imagesError}
                  render={
                    <Button
                      type="button"
                      aria-label="Send options"
                      className="h-10.5 rounded-l-none border-l border-l-background/30 px-2"
                    />
                  }
                >
                  <ChevronDownIcon />
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-64">
                  <DropdownMenuItem onClick={() => void submit("steer")}>
                    Add to this turn
                    <DropdownMenuShortcut>Enter</DropdownMenuShortcut>
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => void submit("queue")}>
                    Send when this turn ends
                    <DropdownMenuShortcut>⌥Enter</DropdownMenuShortcut>
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => void submit("interrupt")}>
                    Stop the turn and send
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            )}
          </div>
        )}
      </div>
      {/* Shown where the kernel reads them: not yet Codex's on a joined computer. */}
      {open && <SessionSettings session={session} perform={perform} />}
      <div className="mx-auto flex w-full max-w-3xl items-center gap-3 font-mono text-[11px] text-faint">
        <p className="min-w-0 flex-1">
          {tooLong
            ? "Too long: up to 64 KB."
            : imagesError
              ? imagesError
              : !owner || command?.name === "compact"
                ? null
                : working
                  ? modes
                    ? "⌥Enter sends when the turn ends · Esc interrupts"
                    : "Esc interrupts"
                  : "/ for commands · @ for files"}
        </p>
        <ContextMeter
          usage={usage}
          compact={
            open && !text.trim()
              ? () => place("/compact ", "/compact ".length)
              : undefined
          }
        />
      </div>
    </form>
  );
}

/**
 * How full the session's context is, beside its box; nearly full, it says how to make room.
 * With `compact`, choosing it puts /compact in the box.
 */
export function ContextMeter({
  usage,
  compact,
}: {
  usage: SessionUsage | null;
  compact?: () => void;
}) {
  const share = contextShare(usage);
  if (share === undefined || !usage) return null;
  const full = share >= 0.8;
  const meter = (
    <span
      role="meter"
      aria-label="Context"
      aria-valuenow={Math.round(share * 100)}
      aria-valuemin={0}
      aria-valuemax={100}
      title={`${tokenCount(usage.context_tokens ?? 0)} of ${tokenCount(usage.context_window ?? 0)} tokens`}
      className={cn(
        "flex shrink-0 items-center gap-1.5",
        full && "text-attention",
        share >= 0.95 && "text-destructive",
      )}
    >
      <svg viewBox="0 0 16 16" aria-hidden className="size-3.5 -rotate-90">
        <circle
          cx="8"
          cy="8"
          r="6"
          fill="none"
          strokeWidth="2"
          className="stroke-border"
        />
        <circle
          cx="8"
          cy="8"
          r="6"
          fill="none"
          strokeWidth="2"
          stroke="currentColor"
          pathLength={100}
          strokeDasharray={`${share * 100} 100`}
        />
      </svg>
      {percent(share)} context
    </span>
  );
  return compact ? (
    <button
      type="button"
      onClick={compact}
      className="rounded-sm transition-colors outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50"
    >
      {meter}
    </button>
  ) : (
    meter
  );
}

/**
 * The session's plan, pinned above the box: how far it is and the step in hand; opened,
 * every step.
 */
function PlanBar({ steps }: { steps: PlanStep[] }) {
  const [open, setOpen] = useState(false);
  const panel = useId();
  const done = steps.filter((step) => step.status === "done").length;
  const current =
    steps.find((step) => step.status === "active") ??
    steps.find((step) => step.status !== "done");
  return (
    <div className="mx-auto w-full max-w-3xl overflow-hidden rounded-md border bg-card text-sm">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={panel}
        onClick={() => setOpen(!open)}
        className="group/plan flex w-full items-center gap-2 px-3 py-1.5 text-left transition-colors outline-none hover:bg-accent focus-visible:bg-accent"
      >
        <ListChecksIcon aria-hidden className="size-3.5 shrink-0 text-agent" />
        <span className="shrink-0 font-mono text-[11px] text-faint">
          {done} of {steps.length}
        </span>
        <span className="min-w-0 truncate text-[13px] group-aria-expanded/plan:invisible">
          {current?.text}
        </span>
        <ChevronDownIcon
          aria-hidden
          className="ml-auto size-3.5 shrink-0 text-faint transition-transform group-aria-expanded/plan:rotate-180 motion-reduce:transition-none"
        />
      </button>
      <Reveal open={open} id={panel}>
        <div className="max-h-60 overflow-y-auto border-t px-3 py-2">
          <PlanSteps steps={steps} />
        </div>
      </Reveal>
    </div>
  );
}

/**
 * The session's own model, effort and permissions, under its box: read from its harness,
 * changed through it at once. Only what the harness lets change now is offered.
 */
function SessionSettings({
  session,
  perform,
}: {
  session: ChatSession;
  perform: Perform;
}) {
  const settings = useSessionSettings(
    session.id,
    `${session.status}:${session.activity}`,
  );
  const values = settings.data?.values ?? {};
  const models = settings.data?.models ?? [];
  const editable = settings.data?.editable ?? [];
  const fields = agentSettingFields(session.harness, models, values.model);
  // Plan first, in each harness's own setting: Codex's mode, Claude Code's permissions.
  const plan = planMode(session.harness, values, editable);
  if (!settings.data || !editable.length) return null;
  // One field at a time; the harness confirms it, or says why not.
  const change = (key: keyof AgentSettings, value: string) =>
    void perform(async () => void (await settings.apply({ [key]: value })));
  return (
    <div
      role="group"
      aria-label="Session settings"
      className="mx-auto flex w-full max-w-3xl flex-wrap items-center gap-1.5"
    >
      {fields.map(({ key, label, options }) => {
        const value = values[key] ?? "";
        return (
          <NativeSelect
            key={key}
            size="sm"
            aria-label={label}
            title={label}
            value={value}
            disabled={
              !editable.includes(key) || Object.keys(options).length === 0
            }
            onChange={(event) => change(key, event.target.value)}
          >
            {!value && (
              <NativeSelectOption value="" disabled>
                {label}
              </NativeSelectOption>
            )}
            {value && !Object.hasOwn(options, value) && (
              <NativeSelectOption value={value} disabled>
                {value}
              </NativeSelectOption>
            )}
            {Object.entries(options).map(([option, text]) => (
              <NativeSelectOption key={option} value={option}>
                {key === "model" || key === "effort"
                  ? text
                  : `${label}: ${text}`}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        );
      })}
      {plan && (
        <Toggle
          size="sm"
          variant="outline"
          pressed={plan.on}
          title="Plan mode"
          onPressedChange={(on) =>
            void perform(
              async () => void (await settings.apply(plan.change(on))),
            )
          }
        >
          <ListChecksIcon />
          Plan
        </Toggle>
      )}
      {settings.error && (
        <span className="text-xs text-attention">{settings.error}</span>
      )}
    </div>
  );
}

/** An input on its way to the session: sending, sent, or failed with its error. */
function SentInputBubble({
  input,
  retry,
  drop,
}: {
  input: SentInput;
  retry: () => void;
  drop: () => void;
}) {
  return (
    <InputBubble text={input.text}>
      {input.status === "failed" ? (
        <div className="flex items-center gap-2">
          <p role="alert" className="text-xs text-destructive">
            {input.error}
          </p>
          <Button size="xs" variant="outline" onClick={retry}>
            Retry
          </Button>
          <Button size="xs" variant="ghost" onClick={drop}>
            Discard
          </Button>
        </div>
      ) : (
        <span className="font-mono text-[11px] text-faint">
          {input.status === "sending" ? "Sending…" : "Sent"}
        </span>
      )}
    </InputBubble>
  );
}

/**
 * The owner's inputs waiting for the turn to end, above the box, in the order they will go.
 * Where the harness allows it, each can be rewritten or taken out before it runs.
 */
export function QueueCards({
  queue,
  busy,
  change,
}: {
  queue: QueuedInput[];
  busy: boolean;
  change?: {
    remove: (item: QueuedInput) => Promise<boolean>;
    edit: (item: QueuedInput, text: string) => Promise<boolean>;
  };
}) {
  const [editing, setEditing] = useState<{ id: string; text: string }>();
  return (
    <ul
      aria-label="Queue"
      className="mx-auto flex w-full max-w-3xl flex-col gap-1.5"
    >
      {queue.map((item) => (
        <li
          key={item.id}
          className="flex items-start gap-2 rounded-md border border-dashed bg-card px-3 py-2 text-sm"
        >
          <span className="mt-0.5 shrink-0 font-mono text-[11px] text-faint">
            Queued
          </span>
          {editing?.id === item.id ? (
            <form
              className="flex min-w-0 flex-1 flex-col gap-2"
              onSubmit={(event) => {
                event.preventDefault();
                const text = editing.text.trim();
                if (text && change)
                  void change.edit(item, text).then((done) => {
                    if (done) setEditing(undefined);
                  });
              }}
            >
              <textarea
                aria-label="Queued input"
                value={editing.text}
                autoFocus
                rows={2}
                onChange={(event) =>
                  setEditing({ id: item.id, text: event.target.value })
                }
                className="min-h-14 resize-none rounded-sm border border-input bg-background px-2 py-1.5 text-sm outline-none focus:border-ring"
              />
              <div className="flex gap-2">
                <Button
                  type="submit"
                  size="sm"
                  disabled={busy || !editing.text.trim()}
                >
                  Save
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => setEditing(undefined)}
                >
                  Cancel
                </Button>
              </div>
            </form>
          ) : (
            <p className="line-clamp-2 min-w-0 flex-1 whitespace-pre-wrap">
              {item.text}
            </p>
          )}
          {change && editing?.id !== item.id && (
            <span className="flex shrink-0 gap-0.5">
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label="Rewrite"
                disabled={busy}
                onClick={() => setEditing({ id: item.id, text: item.text })}
              >
                <PencilIcon />
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label="Take out of the queue"
                disabled={busy}
                onClick={() => void change.remove(item)}
              >
                <XIcon />
              </Button>
            </span>
          )}
        </li>
      ))}
    </ul>
  );
}
