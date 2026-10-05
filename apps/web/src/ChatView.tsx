import { Fragment, useEffect, useRef, useState } from "react";
import type { SubmitEvent } from "react";
import { Link, NavLink } from "react-router";
import { cn } from "cn";
import {
  AudioLinesIcon,
  CheckIcon,
  ChevronLeftIcon,
  ClockIcon,
  MessagesSquareIcon,
  MicIcon,
  PanelRightIcon,
  PaperclipIcon,
  PhoneIcon,
  SendIcon,
  SquarePenIcon,
  XIcon,
} from "lucide-react";
import type { Actor } from "./api";
import {
  agentMembers,
  agentsForChat,
  chatFilters,
  clockTime,
  dayLabel,
  deliveryLabels,
  directChat,
  errorMessage,
  harnessLabels,
  isThread,
  listChats,
  listTime,
  liveSessions,
  newId,
  presenceLine,
  receipt,
  receiptLabels,
  threadsOf,
  transcribe,
  unreadIn,
  waitingChats,
  workingIn,
} from "@zerolux/chat";
import type {
  Chat,
  ChatFilter,
  Conversation,
  Message,
  Perform,
  Receipt,
  Storage,
} from "@zerolux/chat";
import { ApprovalCard, openApprovals } from "./Approvals";
import { canRecord, useRecorder } from "./recorder";
import { ChatAbout } from "@/components/chat-about";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  NativeSelect,
  NativeSelectOption,
} from "@/components/ui/native-select";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { MessageText } from "@/components/message-text";
import { ActorMark, Eyebrow } from "@/components/presence";

const MAX_TEXT = 64 * 1024;
// Messages from one author a few minutes apart read as one turn.
const TURN = 5 * 60 * 1000;

/** The chat page: your chats, and beside them the open one or a new one. */
export function Chats({
  chat,
  actors,
  open,
  children,
}: {
  chat: Chat;
  actors: Actor[];
  /** On a phone the open chat takes the screen; otherwise the list does. */
  open: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className="grid min-h-0 flex-1 md:grid-cols-[18rem_minmax(0,1fr)]">
      <ChatList
        chat={chat}
        actors={actors}
        className={cn(open && "max-md:hidden")}
      />
      <div
        className={cn(
          "flex min-h-0 min-w-0 flex-col",
          !open && "max-md:hidden",
        )}
      >
        {children}
      </div>
    </div>
  );
}

/** Every chat, the newest activity first; the ones waiting for you are marked. */
function ChatList({
  chat,
  actors,
  className,
}: {
  chat: Chat;
  actors: Actor[];
  className?: string;
}) {
  const [filter, setFilter] = useState<ChatFilter>("all");
  const name = (id: string) =>
    actors.find((a) => a.id === id)?.name ?? "Former member";
  const waiting = waitingChats(
    chat.conversations,
    chat.approvals,
    chat.sessions,
  );
  const shown = listChats(chat.conversations, filter, waiting);

  return (
    <section
      aria-label="Chats"
      className={cn("flex min-h-0 flex-col md:border-r", className)}
    >
      <header className="flex items-center justify-between px-4 pt-4 pb-3">
        <h2 className="text-lg font-semibold tracking-tight">Chats</h2>
        <Link
          to="/chats/new"
          aria-label="New chat"
          title="New chat"
          className={buttonVariants({ variant: "ghost", size: "icon-sm" })}
        >
          <SquarePenIcon />
        </Link>
      </header>
      <div
        role="group"
        aria-label="Show"
        className="mx-3 mb-2 flex w-fit gap-0.5 rounded-sm border bg-background p-0.5"
      >
        {(Object.keys(chatFilters) as ChatFilter[]).map((f) => (
          <button
            key={f}
            type="button"
            aria-pressed={filter === f}
            onClick={() => setFilter(f)}
            className="h-6 rounded-[3px] px-2.5 text-[12.5px] font-medium text-muted-foreground transition-colors hover:text-foreground aria-pressed:bg-secondary aria-pressed:text-foreground aria-pressed:shadow-[0_0_0_1px_var(--color-input)]"
          >
            {chatFilters[f]}
            {f === "you" && waiting.size > 0 && (
              <span className="ml-1.5 font-mono text-[11px] text-attention">
                {waiting.size}
              </span>
            )}
          </button>
        ))}
      </div>
      <nav
        aria-label="Your chats"
        className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto px-2 pb-3"
      >
        {shown.map((c) => {
          const agent =
            c.kind === "dm" ? agentMembers(c, actors)[0] : undefined;
          const unread = unreadIn(c, chat.seen);
          const last = c.last_message;
          return (
            <NavLink
              key={c.id}
              to={`/chats/${c.id}`}
              className="flex items-center gap-3 rounded-md px-2 py-2.5 transition-colors hover:bg-accent aria-[current=page]:bg-accent"
            >
              <ChatMark conversation={c} actors={actors} />
              <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="flex items-baseline gap-2">
                  <span className="truncate text-sm font-medium">
                    {c.title}
                  </span>
                  {agent?.harness && (
                    <span className="shrink-0 font-mono text-[11px] text-faint">
                      {harnessLabels[agent.harness]}
                    </span>
                  )}
                  {last && (
                    <time
                      dateTime={new Date(last.created_at).toISOString()}
                      className="ml-auto shrink-0 font-mono text-[11px] text-faint"
                    >
                      {listTime(last.created_at)}
                    </time>
                  )}
                </span>
                <span className="flex items-center gap-2">
                  <span className="truncate text-[13px] text-muted-foreground">
                    {c.paused
                      ? "Paused"
                      : last
                        ? `${name(last.author_id)}: ${last.text}`
                        : presenceLine(c, chat.sessions, name)}
                  </span>
                  {(unread > 0 || waiting.has(c.id)) && (
                    <span
                      role="img"
                      aria-label={
                        waiting.has(c.id)
                          ? "Waiting for you"
                          : `${unread} new message${unread === 1 ? "" : "s"}`
                      }
                      data-attention={waiting.has(c.id) || undefined}
                      className="ml-auto grid h-4.5 min-w-4.5 shrink-0 place-items-center rounded-full bg-foreground px-1.5 font-mono text-[11px] font-medium text-background data-attention:bg-attention data-attention:text-attention-foreground"
                    >
                      {unread > 99 ? "99+" : unread || "!"}
                    </span>
                  )}
                </span>
              </span>
            </NavLink>
          );
        })}
        {shown.length === 0 && (
          <p className="px-2 py-6 text-sm text-faint">
            {filter === "you"
              ? "Nothing is waiting for you."
              : filter === "groups"
                ? "No group chats yet."
                : "No chats yet."}
          </p>
        )}
      </nav>
    </section>
  );
}

/** A chat's mark: the agent of a direct chat, a group's initial on a wider tile. */
function ChatMark({
  conversation,
  actors,
  className,
}: {
  conversation: Conversation;
  actors: Actor[];
  className?: string;
}) {
  const agent =
    conversation.kind === "dm"
      ? agentMembers(conversation, actors)[0]
      : undefined;
  if (agent)
    return (
      <ActorMark
        kind="agent"
        name={agent.name}
        className={cn("size-10", className)}
      />
    );
  return (
    <span
      aria-hidden
      className={cn(
        "grid size-10 shrink-0 place-items-center rounded-[10px] border border-input bg-secondary text-[15px] font-semibold",
        className,
      )}
    >
      {conversation.kind === "thread" ? (
        <MessagesSquareIcon className="size-4 text-faint" />
      ) : (
        conversation.title.slice(0, 1).toUpperCase()
      )}
    </span>
  );
}

export function ChatView({
  chat,
  conversation,
  actors,
  ownerId,
  busy,
  perform,
  hire,
  storage,
  capabilities,
}: {
  chat: Chat;
  conversation: Conversation;
  actors: Actor[];
  ownerId: string;
  busy: boolean;
  perform: Perform;
  hire: () => void;
  storage: Storage;
  capabilities: string[];
}) {
  const [adding, setAdding] = useState(false);
  // Beside the chat on a wide screen; over it, on request, on a narrower one.
  const [about, setAbout] = useState(true);
  const [aboutSheet, setAboutSheet] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLOListElement>(null);
  const last = chat.messages.at(-1)?.seq;
  const unsent = chat.unsent.filter(
    (m) => m.conversation_id === conversation.id,
  );
  // Who is working on this chat now: shown as a bubble under the last message.
  const busyHere = workingIn(conversation, chat.sessions);
  const asks = openApprovals(chat.approvals).filter(
    (a) => a.conversation_id === conversation.id,
  );
  // Follows new messages only while you are at the bottom: reading older ones is not interrupted.
  const following = useRef(true);
  // The content height the reader last scrolled against.
  const height = useRef(0);
  const toBottom = () => {
    const l = scroller.current;
    if (!l) return;
    if (following.current) l.scrollTop = l.scrollHeight;
    height.current = l.scrollHeight;
  };
  useEffect(toBottom, [last, unsent.length, busyHere.length, asks.length]);
  useEffect(() => {
    // The bottom stays in view while content grows once shown (a diagram, highlighted code)
    // and while the view itself shrinks (a strip of open threads, a taller draft).
    if (!list.current || !scroller.current) return;
    const observer = new ResizeObserver(toBottom);
    observer.observe(list.current);
    observer.observe(scroller.current);
    return () => observer.disconnect();
    // toBottom only reads refs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const agents = agentMembers(conversation, actors);
  const actor = (id: string) => actors.find((a) => a.id === id);
  const name = (id: string) => actor(id)?.name ?? "Former member";
  const working = conversation.members.some(
    (m) =>
      chat.sessions.find((s) => s.id === m.session_id)?.activity === "working",
  );
  // Agents coordinate in threads under a chat; the owner reads them, the answer comes here.
  const thread = isThread(conversation);
  const parent = chat.conversations.find(
    (c) => c.id === conversation.parent_id,
  );
  const threads = threadsOf(conversation, chat.conversations);
  const threadOn = (messageId: string) =>
    threads.find((t) => t.root_message_id === messageId);
  const open = threads.filter((t) => !t.closed_at);
  const aboutPanel = (
    <ChatAbout
      conversation={conversation}
      actors={actors}
      sessions={chat.sessions}
      storage={storage}
      className="h-full"
    />
  );

  return (
    <div className="flex min-h-0 flex-1">
      <section
        aria-label={conversation.title}
        className="flex min-h-0 min-w-0 flex-1 flex-col"
      >
        <header className="flex min-h-14 shrink-0 items-center gap-3 border-b px-3 py-2 md:px-5">
          <Link
            to={parent ? `/chats/${parent.id}` : "/chats"}
            aria-label={parent ? `Back to ${parent.title}` : "All chats"}
            className={cn(
              buttonVariants({ variant: "ghost", size: "icon-sm" }),
              !thread && "md:hidden",
            )}
          >
            <ChevronLeftIcon />
          </Link>
          <ChatMark
            conversation={conversation}
            actors={actors}
            className="size-8 text-[13px] max-sm:hidden"
          />
          <div className="min-w-0 flex-1">
            <h2 className="truncate text-[15px] font-semibold">
              {conversation.title}
            </h2>
            <p
              data-working={working || undefined}
              className="truncate text-xs text-muted-foreground data-working:text-agent-foreground"
            >
              {thread &&
                `Thread in «${parent?.title ?? "a chat"}»${conversation.closed_at ? " · closed" : ""} · `}
              {presenceLine(conversation, chat.sessions, name)}
            </p>
          </div>
          {!thread && (
            <Link
              to={`/meetings?chat=${conversation.id}`}
              className={cn(
                buttonVariants({ variant: "outline", size: "sm" }),
                "max-sm:hidden",
              )}
            >
              <PhoneIcon />
              Meet
            </Link>
          )}
          {conversation.kind === "group" && (
            <Button
              variant="outline"
              size="sm"
              aria-expanded={adding}
              onClick={() => setAdding(!adding)}
            >
              Add agent
            </Button>
          )}
          {thread && !conversation.closed_at && (
            <Button
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={() => void perform(() => chat.close(conversation))}
            >
              Close thread
            </Button>
          )}
          {!thread && (
            <Button
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={() =>
                void perform(() =>
                  chat.pause(conversation, !conversation.paused),
                )
              }
            >
              {conversation.paused ? "Resume" : "Pause"}
            </Button>
          )}
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="About this chat"
            aria-pressed={about}
            className="xl:aria-pressed:bg-accent"
            onClick={() =>
              matchMedia("(min-width: 80rem)").matches
                ? setAbout(!about)
                : setAboutSheet(true)
            }
          >
            <PanelRightIcon />
          </Button>
        </header>
        {open.length > 0 && (
          <nav
            aria-label="Open threads"
            className="flex gap-2 overflow-x-auto border-b px-3 py-2 md:px-5"
          >
            {open.map((t) => (
              <ThreadLink key={t.id} thread={t} name={name} />
            ))}
          </nav>
        )}
        {adding && (
          <div className="border-b px-3 py-3 md:px-5">
            <AddAgent
              chat={chat}
              conversation={conversation}
              actors={actors}
              busy={busy}
              perform={perform}
              hire={hire}
              done={() => setAdding(false)}
            />
          </div>
        )}
        {conversation.paused && (
          <p className="border-b bg-attention/10 px-3 py-2 text-sm text-attention md:px-5">
            {thread
              ? `Paused with «${parent?.title ?? "its chat"}»: no agent is woken here until you resume that chat.`
              : "Paused: no agent is woken. New messages are saved and delivered when you resume."}
          </p>
        )}
        <div
          ref={scroller}
          className="min-h-0 flex-1 overflow-y-auto px-3 py-4 md:px-6"
          onScroll={(e) => {
            const l = e.currentTarget;
            // The browser also scrolls when content changes size (scroll anchoring): only a
            // scroll over unchanged content is the reader moving.
            if (l.scrollHeight !== height.current) return;
            following.current =
              l.scrollHeight - l.scrollTop - l.clientHeight < 80;
          }}
        >
          <ol ref={list} className="mx-auto flex max-w-3xl flex-col gap-1">
            {(chat.messages[0]?.seq ?? 1) > 1 && (
              <li className="self-center pb-2">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={busy}
                  onClick={() => void perform(chat.loadEarlier)}
                >
                  Show earlier messages
                </Button>
              </li>
            )}
            {chat.messages.map((m, i) => {
              const previous = chat.messages[i - 1];
              const day = dayLabel(m.created_at);
              const newDay = !previous || dayLabel(previous.created_at) !== day;
              return (
                <Fragment key={m.seq}>
                  {newDay && <DayLabel>{day}</DayLabel>}
                  <MessageRow
                    message={m}
                    mine={m.author_id === ownerId}
                    continued={
                      !newDay &&
                      previous.author_id === m.author_id &&
                      m.created_at - previous.created_at < TURN
                    }
                    author={actor(m.author_id)}
                    name={name}
                  >
                    {threadOn(m.id) && (
                      <ThreadLink thread={threadOn(m.id)!} name={name} />
                    )}
                  </MessageRow>
                </Fragment>
              );
            })}
            {unsent.map((m) => (
              <li
                key={m.id}
                data-mine
                data-unsent
                className="mt-1 max-w-[min(40rem,85%)] self-end rounded-md rounded-br-xs border border-dashed border-human/40 px-3.5 py-2"
              >
                {/* As typed: it is formatted once ZeroLux has it. Rendering it now could load
                    the renderer while ZeroLux is unreachable, and a failed load stays failed. */}
                <p className="text-sm break-words whitespace-pre-wrap">
                  {m.text}
                </p>
                <span className="flex items-center justify-end gap-1 font-mono text-[11px] text-faint">
                  Not sent yet: it goes out when ZeroLux is back
                  <ClockIcon aria-hidden className="size-3" />
                </span>
              </li>
            ))}
            {asks.map((a) => (
              <li key={a.id} className="mt-3">
                <ApprovalCard
                  approval={a}
                  chat={chat}
                  actors={actors}
                  busy={busy}
                  perform={perform}
                />
              </li>
            ))}
            {busyHere.length > 0 && (
              <li
                data-activity
                aria-live="polite"
                className="mt-2 flex items-center gap-2 self-start rounded-full border border-agent/30 bg-agent/10 px-3 py-1.5 font-mono text-[11.5px] text-agent-foreground"
              >
                <span aria-hidden className="flex gap-1">
                  {[0, 300, 600].map((delay) => (
                    <span
                      key={delay}
                      style={{ animationDelay: `${delay}ms` }}
                      className="size-1.5 animate-pulse rounded-[1.5px] bg-agent motion-reduce:animate-none"
                    />
                  ))}
                </span>
                {busyHere.map(name).join(", ")}{" "}
                {busyHere.length === 1 ? "is" : "are"} working
              </li>
            )}
            {chat.messages.length === 0 && conversation.last_seq === 0 && (
              <DayLabel>No messages yet. Say hello.</DayLabel>
            )}
          </ol>
        </div>
        {thread ? (
          <p className="border-t px-3 py-3 text-xs text-muted-foreground md:px-5">
            {conversation.closed_at
              ? "This thread is closed."
              : `Agents coordinate here; the answer comes in «${parent?.title ?? "the chat"}».`}
          </p>
        ) : (
          <Composer
            key={conversation.id}
            chat={chat}
            conversation={conversation}
            agents={agents}
            busy={busy}
            perform={perform}
            storage={storage}
            capabilities={capabilities}
            sent={() => (following.current = true)}
          />
        )}
      </section>
      {about && <div className="w-72 shrink-0 max-xl:hidden">{aboutPanel}</div>}
      <Sheet open={aboutSheet} onOpenChange={setAboutSheet}>
        <SheetContent side="right" className="w-80 gap-0 p-0">
          <SheetTitle className="sr-only">About this chat</SheetTitle>
          {aboutPanel}
        </SheetContent>
      </Sheet>
    </div>
  );
}

/** One message: yours on the right; anyone else's with their mark and name, once per turn. */
function MessageRow({
  message: m,
  mine,
  continued,
  author,
  name,
  children,
}: {
  message: Message;
  mine: boolean;
  continued: boolean;
  author?: Actor;
  name: (actorId: string) => string;
  children?: React.ReactNode;
}) {
  const agent = author?.kind !== "human";
  if (mine)
    return (
      <li
        data-mine
        className={cn(
          "max-w-[min(40rem,85%)] self-end rounded-md rounded-br-xs border border-human/25 bg-human/10 px-3.5 py-2",
          !continued && "mt-3",
        )}
      >
        <MessageText text={m.text} />
        <Stamp message={m} name={name} className="justify-end" />
        {children}
      </li>
    );
  return (
    <li
      className={cn(
        "grid grid-cols-[2rem_minmax(0,1fr)] gap-x-3",
        !continued && "mt-3",
      )}
    >
      {continued ? (
        <span />
      ) : (
        <ActorMark
          kind={agent ? "agent" : "human"}
          name={author?.name ?? "?"}
          className="size-8"
        />
      )}
      <div className="min-w-0">
        {!continued && (
          <div className="flex items-baseline gap-2">
            <strong
              className={cn(
                "text-[13px]",
                agent
                  ? "font-mono font-medium text-agent-foreground"
                  : "font-semibold",
              )}
            >
              {name(m.author_id)}
            </strong>
            {author?.harness && (
              <span className="font-mono text-[11px] text-faint">
                {harnessLabels[author.harness]}
              </span>
            )}
          </div>
        )}
        <MessageText text={m.text} />
        <Stamp message={m} name={name} />
        {children}
      </div>
    </li>
  );
}

/** When it was sent and, one tap away, who has it and who read it. */
function Stamp({
  message: m,
  name,
  className,
}: {
  message: Message;
  name: (actorId: string) => string;
  className?: string;
}) {
  const mark = receipt(m.deliveries);
  const time = (
    <>
      <time dateTime={new Date(m.created_at).toISOString()}>
        {clockTime(m.created_at)}
      </time>
      {mark && <Marks mark={mark} />}
    </>
  );
  const line = cn(
    "flex items-center gap-1 font-mono text-[11px] text-faint",
    className,
  );
  return m.deliveries.length ? (
    <details className="group">
      <summary
        className={cn(
          line,
          "cursor-pointer list-none [&::-webkit-details-marker]:hidden",
        )}
      >
        {time}
      </summary>
      <ul className="mt-1 space-y-0.5 text-[11px] text-muted-foreground">
        {m.deliveries.map((d) => (
          <li key={d.id} data-status={d.status}>
            {name(d.actor_id)} · {deliveryLabels[d.status]}
            {d.last_error && (
              <small className="block text-destructive">{d.last_error}</small>
            )}
          </li>
        ))}
      </ul>
    </details>
  ) : (
    <span className={line}>{time}</span>
  );
}

/**
 * Where you write: Enter adds a line, ⌘ Enter sends. Files, dictation and voice messages go
 * through the kernel; each control waits for the capability it needs.
 */
function Composer({
  chat,
  conversation,
  agents,
  busy,
  perform,
  storage,
  capabilities,
  sent,
}: {
  chat: Chat;
  conversation: Conversation;
  agents: Actor[];
  busy: boolean;
  perform: Perform;
  storage: Storage;
  capabilities: string[];
  sent: () => void;
}) {
  const [text, setText] = useState("");
  const [voice, setVoice] = useState<"dictation" | "message">();
  const [voiceError, setVoiceError] = useState("");
  const recorder = useRecorder();
  // Same ID while the draft is unchanged, so retrying a failed send is idempotent.
  const draft = useRef(newId());
  const box = useRef<HTMLTextAreaElement>(null);
  const files = useRef<HTMLInputElement>(null);
  useEffect(() => {
    // An emptied composer shrinks back to one line.
    if (!text && box.current) box.current.style.height = "";
  }, [text]);
  const tooLong = new TextEncoder().encode(text).length > MAX_TEXT;
  const microphone = canRecord();
  const transcription = capabilities.includes("transcription-v1");
  const edit = (change: () => void) => {
    change();
    draft.current = newId();
  };

  async function submit(event?: SubmitEvent) {
    event?.preventDefault();
    if (!text.trim() || tooLong) return;
    sent();
    const id = draft.current;
    const ok = await perform(() =>
      chat.send(conversation, { id, text: text.trim() }),
    );
    // Only the draft that was sent is cleared: what you typed meanwhile is a new draft.
    if (ok && draft.current === id) edit(() => setText(""));
  }

  async function record(purpose: "dictation" | "message") {
    setVoiceError("");
    try {
      await recorder.start();
      setVoice(purpose);
    } catch (e) {
      setVoiceError(`The microphone is not available: ${errorMessage(e)}`);
    }
  }

  async function finish() {
    const purpose = voice;
    setVoice(undefined);
    const audio = await recorder.stop();
    if (!audio) return;
    if (purpose === "dictation")
      await perform(async () => {
        const said = await transcribe(audio);
        edit(() =>
          setText((t) => (t.trim() ? `${t.trimEnd()} ${said}` : said)),
        );
      });
    else {
      const at = new Date().toTimeString().slice(0, 5).replace(":", ".");
      // TODO: kernel: a file shared in a chat is announced to its members, as a message would be.
      await storage.upload(
        [new File([audio], `Voice message ${at}.webm`, { type: audio.type })],
        { conversation_id: conversation.id },
      );
    }
  }

  function cancel() {
    setVoice(undefined);
    recorder.cancel();
  }

  if (voice)
    return (
      <div className="flex items-center gap-3 border-t px-3 py-3 md:px-5">
        <span
          aria-hidden
          className="size-2.5 animate-pulse rounded-full bg-destructive"
        />
        <span role="status" className="flex-1 font-mono text-sm">
          {voice === "dictation" ? "Listening" : "Recording"} ·{" "}
          {Math.floor(recorder.seconds / 60)}:
          {String(recorder.seconds % 60).padStart(2, "0")}
        </span>
        <Button
          variant="ghost"
          size="icon"
          aria-label="Discard"
          onClick={cancel}
        >
          <XIcon />
        </Button>
        <Button disabled={busy} onClick={() => void finish()}>
          {voice === "dictation" ? "Write it" : "Send voice message"}
          <SendIcon data-icon="inline-end" />
        </Button>
      </div>
    );

  return (
    <form
      className="flex flex-col gap-1.5 border-t px-3 pt-3 pb-2 md:px-5"
      onSubmit={(e) => void submit(e)}
    >
      <div className="flex items-end gap-2">
        <div className="flex min-w-0 flex-1 items-end gap-1 rounded-md border border-input bg-background p-1 transition-[border-color,box-shadow] focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/20">
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label="Attach a file"
            title={
              storage.available
                ? "Attach a file"
                : "Files need storage on the kernel"
            }
            disabled={!storage.available}
            onClick={() => files.current?.click()}
          >
            <PaperclipIcon />
          </Button>
          <input
            ref={files}
            type="file"
            multiple
            hidden
            onChange={(e) => {
              const picked = [...(e.target.files ?? [])];
              e.target.value = "";
              if (picked.length)
                void storage.upload(picked, {
                  conversation_id: conversation.id,
                });
            }}
          />
          <textarea
            ref={box}
            aria-label="Message"
            value={text}
            onChange={(e) => {
              // Grows with the text, up to a few lines; then it scrolls.
              e.target.style.height = "auto";
              e.target.style.height = `${e.target.scrollHeight}px`;
              edit(() => setText(e.target.value));
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                void submit();
              }
            }}
            rows={1}
            className="max-h-40 min-h-8.5 flex-1 resize-none bg-transparent px-1.5 py-1.5 text-sm outline-none placeholder:text-faint"
            placeholder={
              conversation.kind === "group"
                ? `Write to ${conversation.title}`
                : `Write to ${agents[0]?.name ?? "the agent"}`
            }
          />
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label="Dictate"
            title={
              !microphone
                ? "Dictation needs a microphone on a secure address"
                : transcription
                  ? "Dictate"
                  : "Dictation needs speech to text on the kernel"
            }
            disabled={!microphone || !transcription}
            onClick={() => void record("dictation")}
          >
            <MicIcon />
          </Button>
        </div>
        <Button
          type="button"
          variant="outline"
          size="icon"
          aria-label="Record a voice message"
          title={
            !microphone
              ? "Voice messages need a microphone on a secure address"
              : storage.available
                ? "Record a voice message"
                : "Voice messages need storage on the kernel"
          }
          disabled={!microphone || !storage.available}
          onClick={() => void record("message")}
          className="h-10.5 w-10.5"
        >
          <AudioLinesIcon />
        </Button>
        <Button
          type="submit"
          disabled={busy || !text.trim() || tooLong}
          className="h-10.5"
        >
          Send
          <SendIcon data-icon="inline-end" />
        </Button>
      </div>
      <p className="flex flex-wrap justify-between gap-x-4 font-mono text-[11px] text-faint">
        <span>
          {tooLong
            ? "This message is too long (64 KB maximum)."
            : !agents.length
              ? "No agents in this chat."
              : voiceError || storage.error}
        </span>
        <span className="max-sm:hidden">Enter adds a line · ⌘ Enter sends</span>
      </p>
    </form>
  );
}

/** A thread under a chat: its subject, who coordinates in it, and whether it is closed. */
function ThreadLink({
  thread,
  name,
}: {
  thread: Conversation;
  name: (actorId: string) => string;
}) {
  return (
    <Link
      to={`/chats/${thread.id}`}
      data-closed={thread.closed_at ? true : undefined}
      className="mt-1.5 inline-flex max-w-full shrink-0 items-center gap-1.5 rounded-full border bg-background/60 px-2.5 py-1 text-xs transition-colors hover:bg-accent data-closed:text-muted-foreground"
    >
      <MessagesSquareIcon
        aria-hidden
        className="size-3.5 shrink-0 text-agent-foreground"
      />
      <span className="truncate font-medium">{thread.title}</span>
      <span className="shrink-0 text-muted-foreground">
        · {thread.members.map((m) => name(m.actor_id)).join(", ")}
        {thread.closed_at ? " · closed" : ""}
      </span>
    </Link>
  );
}

function DayLabel({ children }: { children: React.ReactNode }) {
  return (
    <li
      data-day
      className="my-3 flex items-center gap-3 font-mono text-[11px] tracking-[0.09em] text-faint uppercase before:h-px before:flex-1 before:bg-border after:h-px after:flex-1 after:bg-border"
    >
      {children}
    </li>
  );
}

/** One mark per message: ✓ saved, ✓✓ everyone has it, ✓✓ lit when everyone read it. */
function Marks({ mark }: { mark: Receipt }) {
  return (
    <span
      data-receipt={mark}
      title={receiptLabels[mark]}
      className="relative inline-flex text-faint data-[receipt=read]:text-agent-foreground"
    >
      <CheckIcon aria-hidden className="size-3.5" />
      {mark !== "sent" && <CheckIcon aria-hidden className="-ml-2 size-3.5" />}
      <span className="sr-only">{receiptLabels[mark]}</span>
    </span>
  );
}

/** Adds a hired agent to a group; it reads the history, and later messages reach it. */
export function AddAgent({
  chat,
  conversation,
  actors,
  busy,
  perform,
  hire,
  done,
}: {
  chat: Chat;
  conversation: Conversation;
  actors: Actor[];
  busy: boolean;
  perform: Perform;
  hire: () => void;
  done: () => void;
}) {
  const [chosen, setChosen] = useState<Record<string, string>>({});
  const memberIds = conversation.members.map((m) => m.actor_id);
  const candidates = actors.filter(
    (a) =>
      a.kind === "agent" &&
      !a.archived &&
      !memberIds.includes(a.id) &&
      liveSessions(chat.sessions, a.id).length > 0,
  );
  if (candidates.length === 0)
    return (
      <p className="text-sm text-muted-foreground">
        Every hired agent is already in this chat.{" "}
        <Button variant="link" className="h-auto p-0" onClick={hire}>
          Hire another agent
        </Button>
      </p>
    );
  return (
    <ul className="flex flex-col divide-y">
      {candidates.map((agent) => {
        const choices = liveSessions(chat.sessions, agent.id);
        // A candidate has at least one live session.
        const current =
          choices.find((c) => c.id === chosen[agent.id]) ?? choices[0]!;
        return (
          <li
            key={agent.id}
            className="flex flex-wrap items-center gap-3 py-2 first:pt-0 last:pb-0"
          >
            <div className="flex min-w-0 flex-1 flex-col gap-1">
              <strong className="text-sm font-medium">{agent.name}</strong>
              {choices.length > 1 ? (
                <NativeSelect
                  aria-label={`${agent.name} session`}
                  value={current.id}
                  onChange={(e) =>
                    setChosen({ ...chosen, [agent.id]: e.target.value })
                  }
                >
                  {choices.map((s) => (
                    <NativeSelectOption key={s.id} value={s.id}>
                      {s.title} · {s.workspace}
                    </NativeSelectOption>
                  ))}
                </NativeSelect>
              ) : (
                <span className="text-xs text-muted-foreground">
                  {current.title}
                </span>
              )}
            </div>
            <Button
              disabled={busy}
              onClick={() =>
                void perform(async () => {
                  await chat.addMember(conversation, agent.id, current.id);
                  done();
                })
              }
            >
              Add
            </Button>
          </li>
        );
      })}
    </ul>
  );
}

export function NewConversation({
  chat,
  actors,
  ownerId,
  busy,
  perform,
  open,
  hire,
}: {
  chat: Chat;
  actors: Actor[];
  ownerId: string;
  busy: boolean;
  perform: Perform;
  open: (conversation: Conversation) => void;
  hire: () => void;
}) {
  const [kind, setKind] = useState<Conversation["kind"]>("dm");
  const [picked, setPicked] = useState<string[]>([]);
  const [chosenSession, setChosenSession] = useState<Record<string, string>>(
    {},
  );
  const [title, setTitle] = useState("Team");
  const agents = agentsForChat(actors, chat.sessions, picked);
  const members = kind === "dm" ? picked.slice(0, 1) : picked;
  const sessionFor = (actorId: string) => {
    const sessions = liveSessions(chat.sessions, actorId);
    return sessions.find((s) => s.id === chosenSession[actorId]) ?? sessions[0];
  };
  const ready =
    members.length > 0 &&
    members.every((id) => sessionFor(id)) &&
    (kind === "dm" || title.trim().length > 0);

  async function submit(event: SubmitEvent) {
    event.preventDefault();
    if (!ready) return;
    const existing =
      kind === "dm" && directChat(chat.conversations, ownerId, members[0]!);
    if (existing) return open(existing);
    await perform(async () =>
      open(
        await chat.create(
          kind,
          kind === "dm"
            ? (actors.find((a) => a.id === members[0])?.name ?? "Chat")
            : title.trim(),
          members.map((id) => ({
            actor_id: id,
            session_id: sessionFor(id)!.id,
          })),
        ),
      ),
    );
  }

  if (agents.length === 0)
    return (
      <Card className="max-w-xl">
        <CardHeader>
          <Eyebrow>New chat</Eyebrow>
          <CardTitle>Hire an agent to start chatting.</CardTitle>
        </CardHeader>
        <CardContent>
          <Button onClick={hire}>Hire an agent</Button>
        </CardContent>
      </Card>
    );
  return (
    <Card className="max-w-xl">
      <CardHeader>
        <Eyebrow>New chat</Eyebrow>
        <CardTitle>Who do you want to talk to?</CardTitle>
      </CardHeader>
      <CardContent>
        <form className="flex flex-col gap-5" onSubmit={(e) => void submit(e)}>
          <div
            role="radiogroup"
            aria-label="Chat type"
            className="inline-flex w-fit gap-0.5 rounded-sm border bg-background p-0.5"
          >
            {(["dm", "group"] as const).map((k) => (
              <label
                key={k}
                className="relative cursor-pointer rounded-[3px] px-3 py-1 text-[12.5px] font-medium text-muted-foreground has-checked:bg-secondary has-checked:text-foreground has-checked:shadow-[0_0_0_1px_var(--color-input)] has-focus-visible:ring-3 has-focus-visible:ring-ring/50"
              >
                <input
                  type="radio"
                  name="kind"
                  className="sr-only"
                  checked={kind === k}
                  onChange={() => setKind(k)}
                />
                {k === "dm" ? "One agent" : "Group"}
              </label>
            ))}
          </div>
          {kind === "group" && (
            <div className="flex flex-col gap-2">
              <Label htmlFor="group-name">Group name</Label>
              <Input
                id="group-name"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="Team"
                maxLength={200}
                required
              />
            </div>
          )}
          <fieldset className="flex flex-col gap-2">
            <legend className="mb-2 text-sm font-medium">
              {kind === "dm" ? "Agent" : "Agents"}
            </legend>
            {agents.map((agent) => {
              const checked = members.includes(agent.id);
              const sessions = liveSessions(chat.sessions, agent.id);
              const current = sessionFor(agent.id);
              return (
                <div
                  key={agent.id}
                  className="flex flex-col gap-2 rounded-sm border p-3 has-checked:border-human/50 has-checked:bg-human/5"
                >
                  <label className="flex cursor-pointer items-center gap-2.5 text-sm">
                    <input
                      type={kind === "dm" ? "radio" : "checkbox"}
                      name="agent"
                      className="size-4 accent-primary"
                      checked={checked}
                      onChange={(e) =>
                        setPicked(
                          kind === "dm"
                            ? [agent.id]
                            : e.target.checked
                              ? [...picked, agent.id]
                              : picked.filter((id) => id !== agent.id),
                        )
                      }
                    />
                    <ActorMark
                      kind="agent"
                      name={agent.name}
                      className="size-6 text-[10px]"
                    />
                    <span className="font-mono">{agent.name}</span>
                  </label>
                  {checked && !current && (
                    <p className="text-xs text-attention">
                      {agent.name} has no live session now.
                    </p>
                  )}
                  {checked && current && sessions.length > 1 && (
                    <NativeSelect
                      aria-label={`${agent.name} session`}
                      value={current.id}
                      className="w-full"
                      onChange={(e) =>
                        setChosenSession({
                          ...chosenSession,
                          [agent.id]: e.target.value,
                        })
                      }
                    >
                      {sessions.map((s) => (
                        <NativeSelectOption key={s.id} value={s.id}>
                          {s.title} · {s.workspace}
                        </NativeSelectOption>
                      ))}
                    </NativeSelect>
                  )}
                </div>
              );
            })}
          </fieldset>
          <Button
            type="submit"
            size="lg"
            className="self-start"
            disabled={busy || !ready}
          >
            Start chat
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}

/** Beside the chat list before one is open: the two steps to a first chat, or a pick. */
export function ChatHome({
  chat,
  hire,
  newChat,
}: {
  chat: Chat;
  hire: () => void;
  newChat: () => void;
}) {
  const hired = chat.sessions.filter((s) => s.status !== "stopped").length;
  const chats = chat.conversations.filter((c) => !isThread(c));
  return (
    <section className="flex max-w-2xl flex-col gap-6">
      <div className="flex flex-col gap-2">
        <Eyebrow>Chats</Eyebrow>
        <h1 className="text-4xl font-light tracking-tight">
          {chats.length ? "Pick a chat." : "Talk with your agents."}
        </h1>
      </div>
      <ol className="grid gap-3 sm:grid-cols-2">
        <Step
          done={hired > 0}
          title="Hire your agents"
          text={
            hired
              ? `${hired} agent session${hired === 1 ? "" : "s"} hired.`
              : "Pick the pi, Claude Code or Codex sessions you already use, or start a new Claude Code agent."
          }
        >
          <Button variant={hired ? "outline" : "default"} onClick={hire}>
            {hired ? "Hire another agent" : "Hire an agent"}
          </Button>
        </Step>
        <Step
          done={chats.length > 0}
          title="Start a chat"
          text="With one agent, or a group such as your whole team."
        >
          <Button
            variant={hired && !chats.length ? "default" : "outline"}
            disabled={!hired}
            onClick={newChat}
          >
            New chat
          </Button>
        </Step>
      </ol>
    </section>
  );
}

function Step({
  done,
  title,
  text,
  children,
}: {
  done: boolean;
  title: string;
  text: string;
  children: React.ReactNode;
}) {
  return (
    <li
      data-done={done || undefined}
      className="flex flex-col items-start gap-2 rounded-md border bg-card p-4 data-done:border-success/40"
    >
      <strong className="flex items-center gap-2 text-sm font-semibold">
        {done && (
          <CheckIcon aria-label="Done" className="size-4 text-success" />
        )}
        {title}
      </strong>
      <p className="text-sm text-muted-foreground">{text}</p>
      {children}
    </li>
  );
}
