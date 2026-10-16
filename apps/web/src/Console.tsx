import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Link, NavLink } from "react-router";
import { ChevronLeftIcon, SendIcon, SquareIcon } from "lucide-react";
import {
  ago,
  consoleSessions,
  draftOf,
  folderName,
  harnessLabels,
  saveDraft,
  sessionBlocks,
  sessionState,
  useSessionEvents,
} from "@zerolux/chat";
import type { Chat, ChatSession, Perform } from "@zerolux/chat";
import type { Actor } from "./api";
import { sessionTone } from "./presence";
import { Presence } from "@/components/presence";
import { Mark } from "@/components/profile";
import { SessionBlocks } from "@/components/session-blocks";
import { Button, buttonVariants } from "@/components/ui/button";
import { SessionCard, resumable, takeable } from "./Team";
import { sendsOnEnter } from "./ChatView";
import { useOwner } from "./AuthGate";

const MAX_TEXT = 64 * 1024;

/** When a session's native output last grew, if the kernel noticed it since this page opened. */
const outputLine = (chat: Chat, session: ChatSession) => {
  const output = chat.outputs[session.id];
  return output ? `Output ${ago(output.at)}` : undefined;
};

const agentName = (actors: Actor[], session: ChatSession) =>
  actors.find((a) => a.id === session.actor_id)?.name ?? "Agent";

/** The Agent Console's column: the live sessions, working first; the stopped ones on request. */
export function ConsoleList({ chat, actors }: { chat: Chat; actors: Actor[] }) {
  const [stopped, setStopped] = useState(false);
  const sessions = consoleSessions(chat.sessions);
  const shown = stopped ? sessions.stopped : sessions.live;
  return (
    <section aria-label="Console" className="flex min-h-0 flex-1 flex-col">
      <header className="px-4 pt-4 pb-3">
        <h2 className="text-lg font-semibold tracking-tight">Console</h2>
      </header>
      <div
        role="group"
        aria-label="Show"
        className="mx-3 mb-2 flex w-fit gap-0.5 rounded-sm border bg-background p-0.5"
      >
        {(
          [
            [false, "Live", sessions.live.length],
            [true, "Stopped", sessions.stopped.length],
          ] as const
        ).map(([value, label, count]) => (
          <button
            key={label}
            type="button"
            aria-pressed={stopped === value}
            onClick={() => setStopped(value)}
            className="h-6 rounded-[3px] px-2.5 text-[12.5px] font-medium text-muted-foreground transition-colors hover:text-foreground aria-pressed:bg-secondary aria-pressed:text-foreground aria-pressed:shadow-[0_0_0_1px_var(--color-input)]"
          >
            {label}
            <span className="ml-1.5 font-mono text-[11px] text-faint">
              {count}
            </span>
          </button>
        ))}
      </div>
      <nav
        aria-label="Agent sessions"
        className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto px-2 pb-3"
      >
        {shown.map((session) => {
          const agent = actors.find((a) => a.id === session.actor_id);
          const tone = sessionTone(session);
          return (
            <NavLink
              key={session.id}
              to={`/console/${session.id}`}
              className="flex items-center gap-3 rounded-md px-2 py-2.5 transition-colors hover:bg-accent aria-[current=page]:bg-accent"
            >
              {agent && <Mark actor={agent} state={tone} className="size-8" />}
              <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="flex items-baseline gap-2">
                  <span className="truncate font-mono text-sm text-agent-foreground">
                    {agentName(actors, session)}
                  </span>
                  <span className="shrink-0 font-mono text-[11px] text-faint">
                    {harnessLabels[session.harness] ?? session.harness}
                  </span>
                </span>
                <span
                  data-working={tone === "working" || undefined}
                  className="truncate text-[13px] text-muted-foreground data-working:text-agent-foreground"
                >
                  {tone === "working"
                    ? sessionState(session)
                    : session.title || "Untitled session"}
                </span>
              </span>
            </NavLink>
          );
        })}
        {shown.length === 0 && (
          <p className="px-2 py-6 text-sm text-faint">
            {stopped ? "No stopped sessions." : "No live sessions."}
          </p>
        )}
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
          ? `${live.length} live${working ? ` · ${working} working` : ""}. Choose a session to follow its work.`
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
  busy,
  perform,
}: {
  session: ChatSession;
  chat: Chat;
  actors: Actor[];
  busy: boolean;
  perform: Perform;
}) {
  const name = agentName(actors, session);
  const agent = actors.find((a) => a.id === session.actor_id);
  const tone = sessionTone(session);
  const working = tone === "working";
  const owner = useOwner(actors);
  const [about, setAbout] = useState(false);
  const { events, error, more, earlier } = useSessionEvents(
    session.id,
    chat.outputs[session.id]?.end,
  );
  const blocks = sessionBlocks(events);
  const scroller = useRef<HTMLDivElement>(null);
  // New work follows at the bottom, as in a chat, while you are there.
  const following = useRef(true);
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
  }, [events]);
  const interrupt = () =>
    void perform(async () => void (await chat.interrupt(session.id)));
  useEffect(() => {
    if (!working || !owner) return;
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
  }, [session.id, working, owner]);
  const chatTitle = (id: string | null) =>
    chat.conversations.find((c) => c.id === id)?.title;
  return (
    <section
      aria-label={`${name}'s session`}
      className="flex min-h-0 min-w-0 flex-1 flex-col"
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
        {agent && <Mark actor={agent} state={tone} className="size-8" />}
        <div className="min-w-0 flex-1">
          <h2 className="truncate font-mono text-[15px] font-medium text-agent-foreground">
            {name}
            <span className="font-sans text-faint">
              {" "}
              · {session.title || "Untitled session"}
            </span>
          </h2>
          <p className="truncate text-xs text-muted-foreground">
            {sessionState(session)} ·{" "}
            {harnessLabels[session.harness] ?? session.harness} ·{" "}
            <span title={session.workspace} className="font-mono">
              {folderName(session.workspace)}
            </span>
          </p>
        </div>
        <Presence tone={tone} className="max-sm:hidden">
          {outputLine(chat, session) ?? sessionState(session)}
        </Presence>
        <Button
          variant="outline"
          size="sm"
          aria-expanded={about}
          onClick={() => setAbout(!about)}
        >
          About this session
        </Button>
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
              busy={busy}
              stop={() => perform(() => chat.stop(session.id))}
              resume={
                resumable(session)
                  ? () => perform(() => chat.resume(session.id))
                  : undefined
              }
              takeover={
                takeable(session)
                  ? () => perform(() => chat.takeoverPi(session.id))
                  : undefined
              }
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
          <SessionBlocks blocks={blocks} chatTitle={chatTitle} />
          {!blocks.length && !error && (
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
        owner={owner}
        working={working}
        busy={busy}
        perform={perform}
        send={(text) => chat.input(session.id, text)}
        interrupt={interrupt}
      />
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
  interrupt,
}: {
  session: ChatSession;
  name: string;
  owner: boolean;
  working: boolean;
  busy: boolean;
  perform: Perform;
  send: (text: string) => Promise<void>;
  interrupt: () => void;
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
  const stops = owner && working && !text.trim();
  async function submit() {
    if (!open || !text.trim() || tooLong) return;
    const sent = text;
    if (!(await perform(() => send(sent.trim())))) return;
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
    >
      <div className="mx-auto flex w-full max-w-3xl items-end gap-2">
        <textarea
          ref={box}
          aria-label={`Write to ${name}`}
          rows={1}
          value={text}
          disabled={!open}
          placeholder={
            !owner
              ? "Only the workspace's owner writes to a session"
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
          }}
          onKeyDown={(event) => {
            if (!sendsOnEnter(event.nativeEvent)) return;
            event.preventDefault();
            void submit();
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
          <Button
            type="submit"
            disabled={busy || !open || !text.trim() || tooLong}
            className="h-10.5"
          >
            Send
            <SendIcon data-icon="inline-end" />
          </Button>
        )}
      </div>
      <p className="mx-auto w-full max-w-3xl font-mono text-[11px] text-faint">
        {tooLong
          ? "Too long: up to 64 KB."
          : !owner
            ? "Its work is open to everyone in the workspace"
            : working
              ? "Joins the turn in progress · Esc interrupts"
              : "Straight into the session, not into a chat"}
      </p>
    </form>
  );
}
