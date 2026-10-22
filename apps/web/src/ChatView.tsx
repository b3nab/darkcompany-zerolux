import { Fragment, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { SubmitEvent } from "react";
import { Link, NavLink } from "react-router";
import { cn } from "cn";
import {
  CheckIcon,
  ChevronLeftIcon,
  ClockIcon,
  MessagesSquareIcon,
  PanelRightIcon,
  PaperclipIcon,
  PhoneIcon,
  SquarePenIcon,
} from "lucide-react";
import type { Actor } from "./api";
import {
  agentMembers,
  agentsForChat,
  chatFilters,
  chatPreview,
  clockTime,
  dayLabel,
  deliveryLabels,
  draftOf,
  directChat,
  harnessLabels,
  isThread,
  listChats,
  listTime,
  liveSessions,
  newId,
  presenceLine,
  receipt,
  receiptLabels,
  saveDraft,
  sessionAccess,
  threadsOf,
  unreadIn,
  waitingChats,
  workingLabel,
  workingSessions,
  useArrivals,
  useChatWork,
  useVoice,
  useUiPieces,
  linkedFiles,
  useSharedFiles,
  withFiles,
} from "@zerolux/chat";
import type {
  Chat,
  ChatFilter,
  ChatTurn,
  Conversation,
  Message,
  Perform,
  Receipt,
  Storage,
  StoredFile,
} from "@zerolux/chat";
import { ApprovalCard, openApprovals } from "./Approvals";
import { MessageActions } from "./extension-view";
import { Composer, ComposerChip } from "@/components/composer";
import { FileCard } from "@/components/file";
import { Listen } from "@/components/listen";
import { useReadAloud } from "./read-aloud";
import { useReadingPlace } from "./reading";
import { LoadingEarlier } from "@/components/loading-earlier";
import { ToLatest } from "@/components/to-latest";
import { ARRIVE } from "@/components/session-blocks";
import { useMe } from "./AuthGate";
import { ChatAbout } from "@/components/chat-about";
import { LiveWork, WorkLine } from "@/components/chat-work";
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
import { SidePanel } from "@/components/side-panel";
import { XL, useMedia } from "./media";

const MAX_TEXT = 64 * 1024;
// Messages from one author a few minutes apart read as one turn.
const TURN = 5 * 60 * 1000;

/** Every chat, the newest activity first; the ones waiting for you are marked. */
export function ChatList({ chat, actors }: { chat: Chat; actors: Actor[] }) {
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
    <section aria-label="Chats" className="flex min-h-0 flex-1 flex-col">
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
          const unread = unreadIn(c);
          const last = c.last_message;
          const preview = chatPreview(
            c,
            chat.conversations,
            chat.sessions,
            name,
          );
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
                  <span
                    data-working={preview.working || undefined}
                    className="truncate text-[13px] text-muted-foreground data-working:text-agent-foreground"
                  >
                    {preview.text}
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
}: {
  chat: Chat;
  conversation: Conversation;
  actors: Actor[];
  ownerId: string;
  busy: boolean;
  perform: Perform;
  hire: () => void;
  storage: Storage;
}) {
  const [adding, setAdding] = useState(false);
  // Speech to text, and the agents that read their messages aloud in their own voice.
  const voice = useVoice();
  // What Storage knows of the files this chat's messages link to: name, kind and size.
  const shared = useSharedFiles(conversation.id);
  // What extensions do with a message, in its menu.
  const messageActions = useUiPieces("message");
  const aloud = useReadAloud();
  // Beside the chat on a wide screen; over it, on request, on a narrower one.
  const [about, setAbout] = useState(true);
  const [aboutSheet, setAboutSheet] = useState(false);
  const wide = useMedia(XL);
  // At the bottom new messages are followed; reading further up, the place is kept, and
  // earlier messages come as the top nears.
  const reading = useReadingPlace<HTMLOListElement>(true, {
    more: (chat.messages[0]?.seq ?? 1) > 1,
    load: chat.loadEarlier,
  });
  // What comes while the chat is open slides in; earlier messages above are simply there.
  const arrivals = useArrivals(chat.messages.map((m) => ({ key: m.id })));
  const last = chat.messages.at(-1)?.seq;
  const unsent = chat.unsent.filter(
    (m) => m.conversation_id === conversation.id,
  );
  // Who is working on this chat now: shown as a bubble under the last message.
  const turnsHere = workingSessions(conversation, chat.sessions);
  const busyHere = turnsHere.map((s) => s.actor_id);
  const { me } = useMe(actors);
  // What each agent did for this chat, read back as far as the messages shown: only from
  // the sessions one may read, since another person's are private unless shared.
  const work = useChatWork(
    conversation.id,
    chat.sessions
      .filter(
        (s) =>
          conversation.members.some((m) => m.session_id === s.id) &&
          sessionAccess(s, me?.id).read,
      )
      .map((s) => s.id),
    chat.outputs,
    chat.messages[0]?.created_at,
  );
  const workError = work.find((w) => w.error)?.error;
  // A turn still running rides the working bubble; each other one sits under the message
  // that opened it.
  const liveTurn = (sessionId: string) => {
    const turn = work.find((w) => w.sessionId === sessionId)?.turns.at(-1);
    return turn && !turn.ended ? turn : undefined;
  };
  const finished = new Map<string, { actorId: string; turn: ChatTurn }[]>();
  for (const { sessionId, turns } of work) {
    const actorId = chat.sessions.find((s) => s.id === sessionId)?.actor_id;
    const live = turnsHere.some((s) => s.id === sessionId)
      ? liveTurn(sessionId)
      : undefined;
    for (const turn of turns)
      if (actorId && turn !== live)
        finished.set(turn.delivery, [
          ...(finished.get(turn.delivery) ?? []),
          { actorId, turn },
        ]);
  }
  // Opened work stays open as a running turn finishes and moves under its message.
  const [opened, setOpened] = useState<ReadonlySet<string>>(new Set());
  const toggle = (key: string) =>
    setOpened((keys) => {
      const next = new Set(keys);
      if (!next.delete(key)) next.add(key);
      return next;
    });
  const asks = openApprovals(chat.approvals).filter(
    (a) => a.conversation_id === conversation.id,
  );
  useLayoutEffect(reading.settle, [
    reading.settle,
    last,
    unsent.length,
    busyHere.length,
    asks.length,
  ]);

  const chatTitle = (id: string | null) =>
    chat.conversations.find((c) => c.id === id)?.title;
  const agents = agentMembers(conversation, actors);
  const actor = (id: string) => actors.find((a) => a.id === id);
  // Sessions in a chat work for its agents; a session without one reads as the owner's.
  const name = (id: string | null) =>
    id ? (actor(id)?.name ?? "Former member") : "Your session";
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
      className="h-full border-l-0"
    />
  );

  return (
    <>
      <SidePanel
        id="chat-about"
        wide={wide}
        panel={wide && about && aboutPanel}
        size={288}
        min={240}
        max={480}
        className="flex min-h-0 flex-1"
      >
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
              onClick={() => (wide ? setAbout(!about) : setAboutSheet(true))}
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
                ? `Paused with «${parent?.title ?? "its chat"}»`
                : "Paused"}
            </p>
          )}
          <div
            ref={reading.scroller}
            className="min-h-0 flex-1 overflow-y-auto px-3 py-4 [overflow-anchor:none] md:px-6"
            onScroll={reading.onScroll}
          >
            <LoadingEarlier
              loading={reading.loadingEarlier}
              label="Loading earlier messages"
            />
            <div ref={reading.top} />
            <ol
              ref={reading.list}
              className="mx-auto flex max-w-3xl flex-col gap-1"
            >
              {chat.messages.map((m, i) => {
                const previous = chat.messages[i - 1];
                const day = dayLabel(m.created_at);
                const newDay =
                  !previous || dayLabel(previous.created_at) !== day;
                return (
                  <Fragment key={m.seq}>
                    {newDay && <DayLabel>{day}</DayLabel>}
                    <MessageRow
                      actions={
                        messageActions.length > 0 && (
                          <MessageActions
                            pieces={messageActions}
                            context={{
                              conversation_id: conversation.id,
                              message_id: m.id,
                            }}
                          />
                        )
                      }
                      message={m}
                      arrived={arrivals.has(m.id)}
                      shared={shared}
                      files={storage.available}
                      mine={m.author_id === ownerId}
                      continued={
                        !newDay &&
                        previous.author_id === m.author_id &&
                        m.created_at - previous.created_at < TURN
                      }
                      author={actor(m.author_id)}
                      name={name}
                      listen={
                        voice.voices?.some((v) => v.actor_id === m.author_id)
                          ? {
                              reading: aloud.reading === m.id,
                              error:
                                aloud.failed?.id === m.id
                                  ? aloud.failed.error
                                  : undefined,
                              toggle: () =>
                                aloud.reading === m.id
                                  ? aloud.stop()
                                  : void aloud.read(m.id, m.author_id, m.text),
                            }
                          : undefined
                      }
                    >
                      {threadOn(m.id) && (
                        <ThreadLink thread={threadOn(m.id)!} name={name} />
                      )}
                    </MessageRow>
                    {m.deliveries.flatMap((d) =>
                      (finished.get(d.id) ?? []).map(({ actorId, turn }) => {
                        const key = `${actorId}:${turn.delivery}`;
                        return (
                          <WorkLine
                            key={key}
                            name={name(actorId)}
                            chatTitle={chatTitle}
                            turn={turn}
                            open={opened.has(key)}
                            toggle={() => toggle(key)}
                          />
                        );
                      }),
                    )}
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
                    Not sent yet
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
              {turnsHere.length > 0 && (
                <li
                  data-activity
                  // Holds its hidden status: positioned against the page, it would make the
                  // whole page as tall as the chat, and the window would scroll with it.
                  className="relative mt-2 flex flex-col gap-1.5"
                >
                  <span role="status" className="sr-only">
                    {workingLabel(busyHere.map(name))}
                  </span>
                  {turnsHere.map((s) => {
                    const turn = liveTurn(s.id);
                    const key = `${s.actor_id}:${turn?.delivery}`;
                    return (
                      <LiveWork
                        key={s.id}
                        name={name(s.actor_id)}
                        chatTitle={chatTitle}
                        turn={turn}
                        open={opened.has(key)}
                        toggle={() => toggle(key)}
                        busy={busy}
                        interrupt={
                          sessionAccess(s, me?.id).write
                            ? () =>
                                void perform(async () => {
                                  await chat.interrupt(s.id);
                                })
                            : undefined
                        }
                      />
                    );
                  })}
                </li>
              )}
              {workError && (
                <li className="mt-2 font-mono text-[11px] text-faint">
                  Agents' work: {workError}
                </li>
              )}
              {chat.messages.length === 0 && conversation.last_seq === 0 && (
                <DayLabel>No messages yet</DayLabel>
              )}
            </ol>
            <ToLatest
              shown={reading.away}
              label="Back to the latest messages"
              onClick={reading.toLatest}
            />
          </div>
          {thread ? (
            conversation.closed_at && (
              <p className="border-t px-3 py-3 text-xs text-muted-foreground md:px-5">
                This thread is closed.
              </p>
            )
          ) : (
            <ChatComposer
              key={conversation.id}
              chat={chat}
              conversation={conversation}
              agents={agents}
              busy={busy}
              perform={perform}
              storage={storage}
              transcription={voice.available}
              sent={reading.follow}
            />
          )}
        </section>
      </SidePanel>
      <Sheet open={aboutSheet} onOpenChange={setAboutSheet}>
        <SheetContent side="right" className="w-80 gap-0 p-0">
          <SheetTitle className="sr-only">About this chat</SheetTitle>
          {aboutPanel}
        </SheetContent>
      </Sheet>
    </>
  );
}

/** A message's words, and a card for each file it shares on a line of its own. */
function MessageBody({
  text,
  shared,
  files,
}: {
  text: string;
  shared: Map<string, StoredFile>;
  files: boolean;
}) {
  const linked = linkedFiles(text);
  return (
    <>
      {linked.text && <MessageText text={linked.text} />}
      {linked.files.length > 0 && (
        <div className="mt-1.5 flex flex-col gap-1.5">
          {linked.files.map((link, i) => (
            <FileCard
              key={`${link.id}:${i}`}
              link={link}
              file={shared.get(link.id)}
              available={files}
            />
          ))}
        </div>
      )}
    </>
  );
}

/** One message: yours on the right; anyone else's with their mark and name, once per turn. */
function MessageRow({
  message: m,
  shared,
  files,
  mine,
  continued,
  author,
  name,
  listen,
  actions,
  arrived,
  children,
}: {
  message: Message;
  /** The files its chat shares, for its links' cards. */
  shared: Map<string, StoredFile>;
  /** Storage is there to download them. */
  files: boolean;
  mine: boolean;
  continued: boolean;
  author?: Actor;
  name: (actorId: string) => string;
  /** Its author's voice reads it aloud. */
  listen?: { reading: boolean; error?: string; toggle: () => void };
  /** What extensions do with it, in its menu. */
  actions?: React.ReactNode;
  /** It came while the chat was open: it slides in. */
  arrived?: boolean;
  children?: React.ReactNode;
}) {
  const agent = author?.kind !== "human";
  const body = <MessageBody text={m.text} shared={shared} files={files} />;
  if (mine)
    return (
      <li
        data-mine
        className={cn(
          "group/message max-w-[min(40rem,85%)] self-end rounded-md rounded-br-xs border border-human/25 bg-human/10 px-3.5 py-2",
          !continued && "mt-3",
        )}
      >
        {body}
        <div className="flex flex-wrap items-center justify-end gap-2">
          {actions}
          <Stamp message={m} name={name} className="justify-end" />
        </div>
        {children}
      </li>
    );
  return (
    <li
      className={cn(
        "group/message grid grid-cols-[2rem_minmax(0,1fr)] gap-x-3",
        !continued && "mt-3",
        arrived && ARRIVE,
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
        {body}
        <div className="flex flex-wrap items-center gap-2">
          <Stamp message={m} name={name} />
          {listen && <Listen {...listen} />}
          {actions}
        </div>
        {children}
      </div>
    </li>
  );
}

/** When it was sent and its mark; hovering the mark tells who has it and who read it. */
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
  // As in chat apps: no tap opens it; the details ride on the mark.
  const detail =
    mark &&
    [
      receiptLabels[mark],
      ...m.deliveries.map(
        (d) =>
          `${name(d.actor_id)}: ${deliveryLabels[d.status]}${d.last_error ? ` (${d.last_error})` : ""}`,
      ),
    ].join("\n");
  return (
    <span
      className={cn(
        "flex items-center gap-1 font-mono text-[11px] text-faint",
        className,
      )}
    >
      <time dateTime={new Date(m.created_at).toISOString()}>
        {clockTime(m.created_at)}
      </time>
      {mark && <Marks mark={mark} detail={detail!} />}
    </span>
  );
}

/** Enter sends; Shift Enter adds a line; nothing goes while an input method composes a word. */
export const sendsOnEnter = (key: {
  key: string;
  shiftKey: boolean;
  isComposing: boolean;
}) => key.key === "Enter" && !key.shiftKey && !key.isComposing;

/**
 * Where you write to a chat: Enter sends, Shift Enter adds a line. Files go through "+";
 * dictation and voice messages through the kernel's voice.
 */
function ChatComposer({
  chat,
  conversation,
  agents,
  busy,
  perform,
  storage,
  transcription,
  sent,
}: {
  chat: Chat;
  conversation: Conversation;
  agents: Actor[];
  busy: boolean;
  perform: Perform;
  storage: Storage;
  /** The workspace turns speech into text. */
  transcription: boolean;
  sent: () => void;
}) {
  // The unsent text waits in its chat while you are elsewhere.
  const [text, setText] = useState(() => draftOf(conversation.id));
  // Same ID while the draft is unchanged, so retrying a failed send is idempotent.
  const draft = useRef(newId());
  const box = useRef<HTMLTextAreaElement>(null);
  const files = useRef<HTMLInputElement>(null);
  useEffect(() => {
    saveDraft(conversation.id, text);
  }, [conversation.id, text]);
  useEffect(() => {
    // Opening a chat puts you in its box where a keyboard is at hand; a touch screen keeps its
    // keyboard down until you tap.
    if (!matchMedia("(pointer: fine)").matches) return;
    box.current?.focus({ preventScroll: true });
    // Clicks keep doing what they do, selecting text included. What you type or paste
    // elsewhere in the chat lands in the box, as in Element and Mattermost: focus moves on
    // keydown, before the character is written.
    const keys = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing) return;
      const paste =
        (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "v";
      const typed =
        (event.key.length === 1 || event.key === "Dead") &&
        !event.metaKey &&
        !event.ctrlKey;
      if (!paste && !typed) return;
      // Another field, or a dialog, keeps its keys; Space presses the control it is on.
      const at = document.activeElement;
      if (
        at?.closest(
          "input, textarea, select, [contenteditable=true], [role=dialog]",
        ) ||
        (event.key === " " && at?.closest("button, a, [role=button]"))
      )
        return;
      box.current?.focus({ preventScroll: true });
    };
    document.addEventListener("keydown", keys);
    return () => document.removeEventListener("keydown", keys);
  }, []);
  const tooLong = new TextEncoder().encode(text).length > MAX_TEXT;
  const write = (next: string) => {
    setText(next);
    draft.current = newId();
  };
  // Files wait in the card, an image as itself, and go when the message does.
  const [picked, setPicked] = useState<{ file: File; url?: string }[]>([]);
  const shown = useRef(picked);
  shown.current = picked;
  useEffect(
    () => () =>
      shown.current.forEach(({ url }) => url && URL.revokeObjectURL(url)),
    [],
  );
  const drop = (file: File) =>
    setPicked((all) =>
      all.filter((one) => {
        if (one.file !== file) return true;
        if (one.url) URL.revokeObjectURL(one.url);
        return false;
      }),
    );

  async function submit() {
    if ((!text.trim() && !picked.length) || tooLong || !agents.length) return;
    sent();
    const id = draft.current;
    const going = picked;
    const ok = await perform(async () => {
      // Files are kept by Storage, shared in this chat, and go as links in the message.
      const uploaded = going.length
        ? await storage.upload(
            going.map(({ file }) => file),
            { conversation_id: conversation.id },
          )
        : [];
      going.forEach(({ file }) => drop(file));
      await chat.send(conversation, { id, text: withFiles(text, uploaded) });
    });
    // Only the draft that was sent is cleared: what you typed meanwhile is a new draft.
    if (ok && draft.current === id) write("");
  }

  return (
    <>
      <input
        ref={files}
        type="file"
        multiple
        hidden
        onChange={(event) => {
          const added = [...(event.target.files ?? [])];
          event.target.value = "";
          setPicked((all) => [
            ...all,
            ...added.map((file) => ({
              file,
              url: file.type.startsWith("image/")
                ? URL.createObjectURL(file)
                : undefined,
            })),
          ]);
        }}
      />
      <Composer
        label="Message"
        placeholder={
          conversation.kind === "group"
            ? `Write to ${conversation.title}`
            : `Write to ${agents[0]?.name ?? "the agent"}`
        }
        text={text}
        setText={write}
        extra={picked.length > 0}
        open
        busy={busy}
        blocked={tooLong || !agents.length}
        box={box}
        textarea={{
          onKeyDown: (event) => {
            if (!sendsOnEnter(event.nativeEvent)) return;
            event.preventDefault();
            void submit();
          },
        }}
        chips={
          picked.length > 0 &&
          picked.map(({ file, url }) => (
            <ComposerChip
              key={url ?? `${file.name}:${file.size}:${file.lastModified}`}
              name={file.name}
              remove={() => drop(file)}
            >
              {url ? (
                <img
                  src={url}
                  alt={file.name}
                  className="size-14 rounded-md border object-cover"
                />
              ) : (
                <span className="flex h-14 max-w-48 items-center gap-2 rounded-md border px-3 text-xs">
                  <PaperclipIcon className="size-3.5 shrink-0 text-faint" />
                  <span className="truncate">{file.name}</span>
                </span>
              )}
            </ComposerChip>
          ))
        }
        add={
          storage.available
            ? [
                {
                  label: "Files",
                  icon: <PaperclipIcon />,
                  take: () => files.current?.click(),
                },
              ]
            : undefined
        }
        error={
          tooLong
            ? "This message is too long (64 KB maximum)."
            : !agents.length
              ? "No agents in this chat."
              : storage.error
        }
        send={() => void submit()}
        voice={{
          transcription,
          // What was said goes as the message, with its recording when Storage keeps it.
          send: async (said, kept) => {
            sent();
            await chat.send(conversation, {
              id: newId(),
              text: withFiles(said, kept ? [kept] : []),
            });
          },
          keep: storage.available
            ? async (audio) => {
                const at = new Date()
                  .toTimeString()
                  .slice(0, 5)
                  .replace(":", ".");
                const [kept] = await storage.upload(
                  [
                    new File([audio], `Voice message ${at}.webm`, {
                      type: audio.type,
                    }),
                  ],
                  { conversation_id: conversation.id },
                );
                return kept!;
              }
            : undefined,
        }}
      />
    </>
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
function Marks({ mark, detail }: { mark: Receipt; detail: string }) {
  return (
    <span
      data-receipt={mark}
      title={detail}
      className="relative inline-flex text-faint data-[receipt=read]:text-agent-foreground"
    >
      <CheckIcon aria-hidden className="size-3.5" />
      {mark !== "sent" && <CheckIcon aria-hidden className="-ml-2 size-3.5" />}
      <span className="sr-only">{detail}</span>
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
          <CardTitle>No agents</CardTitle>
        </CardHeader>
        <CardContent>
          <Button onClick={hire}>Hire an agent</Button>
        </CardContent>
      </Card>
    );
  return (
    <Card className="max-w-xl">
      <CardHeader>
        <CardTitle>New chat</CardTitle>
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
                    <p className="text-xs text-attention">No live session</p>
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
          {chats.length ? "No chat selected" : "No chats yet"}
        </h1>
      </div>
      <ol className="grid gap-3 sm:grid-cols-2">
        <Step
          done={hired > 0}
          title="Hire your agents"
          text={
            hired
              ? `${hired} agent session${hired === 1 ? "" : "s"} hired.`
              : undefined
          }
        >
          <Button variant={hired ? "outline" : "default"} onClick={hire}>
            {hired ? "Hire another agent" : "Hire an agent"}
          </Button>
        </Step>
        <Step done={chats.length > 0} title="Start a chat">
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
  text?: string;
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
      {text && <p className="text-sm text-muted-foreground">{text}</p>}
      {children}
    </li>
  );
}
