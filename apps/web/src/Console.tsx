import { useEffect, useRef, useState } from "react";
import { Link, NavLink } from "react-router";
import {
  ChevronLeftIcon,
  CircleAlertIcon,
  CircleCheckIcon,
  LoaderIcon,
  SendIcon,
  SquareIcon,
} from "lucide-react";
import {
  ago,
  consoleSessions,
  folderName,
  harnessLabels,
  sessionBlocks,
  sessionState,
  toolLine,
  toolText,
  useSessionEvents,
} from "@zerolux/chat";
import type { Chat, ChatSession, Perform, SessionBlock } from "@zerolux/chat";
import type { Actor } from "./api";
import { sessionTone } from "./presence";
import { Presence } from "@/components/presence";
import { Mark } from "@/components/profile";
import { MessageText } from "@/components/message-text";
import { Button, buttonVariants } from "@/components/ui/button";
import { SessionCard, resumable, takeable } from "./Team";

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
  const [about, setAbout] = useState(false);
  const { events, error } = useSessionEvents(
    session.id,
    chat.outputs[session.id]?.end,
  );
  const blocks = sessionBlocks(events);
  const end = useRef<HTMLDivElement>(null);
  // New work follows at the bottom, as in a chat.
  // Braces matter: a newer browser's scrollIntoView returns a promise, never a cleanup.
  useEffect(() => {
    end.current?.scrollIntoView({ block: "end" });
  }, [events]);
  const interrupt = () =>
    void perform(async () => void (await chat.interrupt(session.id)));
  useEffect(() => {
    if (!working) return;
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
  }, [session.id, working]);
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
      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-4 md:px-6">
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
          {blocks.map((block, i) => (
            <Block key={i} block={block} chatTitle={chatTitle} />
          ))}
          {!blocks.length && !error && (
            <p className="text-sm text-faint">Nothing recorded yet.</p>
          )}
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
          <div ref={end} />
        </div>
      </div>
      <form
        className="flex flex-col gap-1.5 border-t px-3 pt-3 pb-2 md:px-5"
        onSubmit={(event) => event.preventDefault()}
      >
        <div className="mx-auto flex w-full max-w-3xl items-end gap-2">
          <textarea
            aria-label={`Write to ${name}`}
            rows={1}
            disabled
            placeholder={`Write to ${name}`}
            className="max-h-40 min-h-10.5 flex-1 resize-none rounded-md border border-input bg-background px-3 py-2.5 text-sm outline-none placeholder:text-faint disabled:opacity-60"
          />
          {working ? (
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
            <Button type="submit" disabled className="h-10.5">
              Send
              <SendIcon data-icon="inline-end" />
            </Button>
          )}
        </div>
        {/* TODO: kernel: input written straight to a session, outside any chat. */}
        <p className="mx-auto w-full max-w-3xl text-xs text-faint">
          Writing straight to a session is not available yet.
        </p>
      </form>
    </section>
  );
}

function Block({
  block,
  chatTitle,
}: {
  block: SessionBlock;
  chatTitle: (id: string | null) => string | undefined;
}) {
  switch (block.kind) {
    case "input":
      return (
        <div className="max-w-[min(40rem,85%)] self-end rounded-md rounded-br-xs border border-human/25 bg-human/10 px-3.5 py-2">
          {block.chat && (
            <p className="mb-1 font-mono text-[11px] text-faint">
              From {chatTitle(block.chat) ?? "a chat"}
            </p>
          )}
          <p className="text-sm whitespace-pre-wrap break-words">
            {block.text}
          </p>
        </div>
      );
    case "text":
      return <MessageText text={block.text} />;
    case "thinking":
      return (
        <details className="group text-sm text-muted-foreground">
          <summary className="cursor-pointer list-none font-mono text-[12px] text-faint [&::-webkit-details-marker]:hidden">
            Thinking
          </summary>
          <p className="mt-1 border-l pl-3 whitespace-pre-wrap">{block.text}</p>
        </details>
      );
    case "tool": {
      const state = !block.result
        ? "running"
        : block.result.error
          ? "error"
          : "done";
      return (
        <details
          data-state={state}
          className="group rounded-md border bg-card text-sm"
        >
          <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2 [&::-webkit-details-marker]:hidden">
            {state === "running" ? (
              <LoaderIcon
                aria-label="Running"
                className="size-3.5 animate-spin text-agent motion-reduce:animate-none"
              />
            ) : state === "error" ? (
              <CircleAlertIcon
                aria-label="Failed"
                className="size-3.5 text-destructive"
              />
            ) : (
              <CircleCheckIcon
                aria-label="Done"
                className="size-3.5 text-faint"
              />
            )}
            <span className="font-mono text-[12.5px] font-medium">
              {block.name}
            </span>
            <span className="truncate font-mono text-[12px] text-muted-foreground">
              {toolLine(block.input)}
            </span>
          </summary>
          <div className="flex flex-col gap-2 border-t px-3 py-2">
            <pre className="max-h-64 overflow-auto font-mono text-[12px] whitespace-pre-wrap text-muted-foreground">
              {toolText(block.input)}
            </pre>
            {block.result && (
              <pre
                data-error={block.result.error || undefined}
                className="max-h-64 overflow-auto border-t pt-2 font-mono text-[12px] whitespace-pre-wrap data-error:text-destructive"
              >
                {toolText(block.result.output)}
              </pre>
            )}
          </div>
        </details>
      );
    }
    case "turn":
      return (
        <p className="my-1 flex items-center gap-3 font-mono text-[11px] text-faint before:h-px before:flex-1 before:bg-border after:h-px after:flex-1 after:bg-border">
          Turn {block.status}
        </p>
      );
    case "error":
      return <p className="text-sm text-destructive">{block.message}</p>;
    case "compacted":
      return (
        <details className="text-sm">
          <summary className="my-1 flex cursor-pointer list-none items-center gap-3 font-mono text-[11px] text-faint before:h-px before:flex-1 before:bg-border after:h-px after:flex-1 after:bg-border [&::-webkit-details-marker]:hidden">
            Context compacted
          </summary>
          {block.summary && (
            <p className="mt-1 whitespace-pre-wrap text-muted-foreground">
              {block.summary}
            </p>
          )}
        </details>
      );
  }
}
