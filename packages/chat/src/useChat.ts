import { useEffect, useRef, useState } from "react";
import { errorMessage, kernelUrl, request } from "./client";
import type { Actor } from "./client";
import {
  PAGE,
  freshness,
  mergeConversation,
  mergeMessages,
  newId,
  outbox,
  pageBefore,
  refreshesSessions,
} from "./chat";
import type {
  Approval,
  ApprovalScope,
  ChatEvent,
  ChatSession,
  Conversation,
  Discovery,
  FormAnswer,
  Member,
  Message,
  InputImage,
  InputMode,
  MessagePage,
  NewSession,
  FilesRewind,
  SessionFork,
  SessionShare,
  Outgoing,
  QuestionAnswer,
} from "./chat";
import { liveNotice, liveResync } from "./live";
import type { LiveRead } from "./live";
import { connectRealtime } from "./realtime";
import type { RealtimeStatus } from "./realtime";
import { extensionsNotice } from "./extensions";
import { unseenInputs } from "./inputs";
import { isLooking, readPositions, whenLooking } from "./reading";
import type { SentInput } from "./inputs";
import type { QueuedInput } from "./live";
import type { SessionBlock } from "./session-events";
import { backgroundNotice, backgroundResync } from "./background";
import { uiNotice, uiResync } from "./extension-ui";
import { terminalNotice, terminalResync } from "./terminals";
import { recordsResync } from "./session-events";

/** Chat state for the owner: LiveKit events say what to refetch from the kernel. */
export function useChat(enabled: boolean, kernel = kernelUrl()) {
  // Bound for its whole life: what waits for one kernel never goes to another.
  const [server] = useState(kernel);
  const api = <T>(path: string, body?: unknown) =>
    request<T>(server, path, body);
  const patch = <T>(path: string, body: unknown) =>
    request<T>(server, path, body, undefined, "PATCH");
  const remove = <T>(path: string) =>
    request<T>(server, path, undefined, undefined, "DELETE");
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [sessions, setSessions] = useState<ChatSession[]>([]);
  const [approvals, setApprovals] = useState<Approval[]>([]);
  const [openId, setOpenId] = useState<string>();
  const [messages, setMessages] = useState<Message[]>([]);
  const [realtime, setRealtime] = useState<RealtimeStatus>("connecting");
  // When each session's native output last grew, as the kernel noticed it.
  const [outputs, setOutputs] = useState<
    Record<string, { end: number; at: number }>
  >({});
  const [error, setError] = useState("");
  const open = useRef<string>(undefined);
  const loaded = useRef<Message[]>([]);
  // An older response never overwrites a newer one (e.g. Working after Idle).
  const [order] = useState(freshness);
  const [unsent, setUnsent] = useState<Outgoing[]>([]);
  // The owner's inputs to sessions, until their records or queues show them.
  const [inputs, setInputs] = useState<SentInput[]>([]);
  // Synchronous: the desktop can ask to restart before React renders a send or its failure.
  const waitingInputs = useRef(new Map<string, SentInput>());
  const [outgoing] = useState(() =>
    outbox(post, setUnsent, (e) => setError(errorMessage(e))),
  );
  // How far the person has read each chat and seen each session, kept by the kernel for all
  // their clients.
  const [positions] = useState(() =>
    readPositions((path, position) =>
      api(path, path.endsWith("/read") ? { seq: position } : { at: position }),
    ),
  );
  const readPath = (id: string) => `/conversations/${id}/read`;
  const seenPath = (id: string) => `/sessions/${id}/seen`;
  function readTo(id: string, seq: number) {
    setConversations((cs) =>
      cs.map((c) =>
        c.id === id && (c.read_seq ?? 0) < seq ? { ...c, read_seq: seq } : c,
      ),
    );
  }
  function seenTo(id: string, at: number) {
    setSessions((ss) =>
      ss.map((s) =>
        s.id === id && (s.seen_at ?? 0) < at ? { ...s, seen_at: at } : s,
      ),
    );
  }
  /** The person read the open chat as far as it is loaded, if they are looking. */
  function readOpen() {
    const id = open.current;
    const last = loaded.current.at(-1)?.seq;
    if (id && last && isLooking() && positions.move(readPath(id), last))
      readTo(id, last);
  }

  async function sendInput(input: SentInput) {
    // In place, in the order they were sent.
    const now = (status: SentInput["status"], error?: string) => {
      if (status === "sent") waitingInputs.current.delete(input.id);
      else waitingInputs.current.set(input.id, { ...input, status, error });
      setInputs((all) =>
        all.some((i) => i.id === input.id)
          ? all.map((i) =>
              i.id === input.id ? { ...input, status, error } : i,
            )
          : [...all, { ...input, status, error }],
      );
    };
    now("sending");
    try {
      await api(`/sessions/${input.session_id}/input`, {
        text: input.text,
        mode: input.mode,
        ...(input.images.length ? { images: input.images } : {}),
      });
      now("sent");
    } catch (e) {
      now("failed", errorMessage(e));
      throw e;
    }
  }

  function merge(id: string, incoming: Message[]) {
    outgoing.received(incoming.map((m) => m.id));
    if (open.current !== id) return;
    loaded.current = mergeMessages(loaded.current, incoming);
    setMessages(loaded.current);
    readOpen();
  }
  async function page(id: string, after: number, limit = PAGE) {
    const request = order.start();
    const result = await api<MessagePage>(
      `/conversations/${id}/messages?after=${after}&limit=${limit}`,
    );
    merge(
      id,
      result.messages.filter((m) => order.accept(`${id}:${m.seq}`, request)),
    );
    return result;
  }
  async function post({ conversation_id, id, text }: Outgoing) {
    // Reads and actions share one order: a late answer never undoes a newer state.
    const request = order.start();
    const sent = await api<Message>(
      `/conversations/${conversation_id}/messages`,
      {
        id,
        text,
        reply_to_delivery_id: null,
      },
    );
    if (order.accept(`${conversation_id}:${sent.seq}`, request))
      merge(conversation_id, [sent]);
    setConversations((cs) =>
      cs.map((c) =>
        c.id === conversation_id
          ? mergeConversation(c, {
              ...c,
              last_seq: sent.seq,
              last_message: {
                author_id: sent.author_id,
                text: sent.text,
                created_at: sent.created_at,
              },
            })
          : c,
      ),
    );
  }
  async function readFrom(id: string, after: number) {
    for (let cursor = after; open.current === id;) {
      const result = await page(id, cursor);
      if (!result.has_more) return;
      cursor = result.next_cursor;
    }
  }
  async function listConversations() {
    const { conversations } = await order.run(
      "conversations",
      () => api<{ conversations: Conversation[] }>("/conversations"),
      ({ conversations }) => {
        for (const c of conversations)
          positions.heard(readPath(c.id), c.read_seq ?? 0);
        setConversations((cs) => {
          const current = new Map(cs.map((c) => [c.id, c]));
          return conversations.map((c) =>
            mergeConversation(current.get(c.id), c),
          );
        });
      },
    );
    return conversations;
  }
  const listSessions = () =>
    order.run(
      "sessions",
      () => api<{ sessions: ChatSession[] }>("/sessions"),
      ({ sessions }) => {
        for (const s of sessions)
          positions.heard(seenPath(s.id), s.seen_at ?? 0);
        // What was seen here meanwhile is not taken back.
        setSessions((current) =>
          sessions.map((s) => {
            const here = current.find((c) => c.id === s.id)?.seen_at ?? 0;
            return here > (s.seen_at ?? 0) ? { ...s, seen_at: here } : s;
          }),
        );
      },
    );
  const listApprovals = () =>
    order.run(
      "approvals",
      () => api<{ approvals: Approval[] }>("/chat/approvals"),
      ({ approvals }) => setApprovals(approvals),
    );
  async function sync() {
    void outgoing.flush(); // The kernel is back: what it missed goes first.
    const [current] = await Promise.all([
      listConversations(),
      listSessions(),
      listApprovals(),
    ]);
    const id = open.current;
    if (!id) return;
    // Re-read shown pages too: delivery states may have changed meanwhile.
    const first = loaded.current[0]?.seq;
    const last = current.find((c) => c.id === id)?.last_seq ?? 0;
    await readFrom(id, first ? first - 1 : pageBefore(last));
  }
  const background = (work: Promise<unknown>) =>
    work.then(
      () => setError(""),
      (e: unknown) => setError(errorMessage(e)),
    );

  function onEvent(event: ChatEvent) {
    if (refreshesSessions(event)) void background(listSessions());
    switch (event.type) {
      case "message.created":
        setConversations((cs) =>
          cs.map((c) =>
            c.id === event.conversation_id
              ? { ...c, last_seq: Math.max(c.last_seq, event.seq) }
              : c,
          ),
        );
        // Events carry IDs, not message text. Fetch previews even for closed chats.
        void background(listConversations());
        if (open.current === event.conversation_id)
          void background(
            readFrom(
              event.conversation_id,
              loaded.current.at(-1)?.seq ?? pageBefore(event.seq),
            ),
          );
        return;
      case "delivery.changed": {
        const shown = loaded.current.find((m) => m.id === event.message_id);
        if (shown && open.current === event.conversation_id)
          void background(page(event.conversation_id, shown.seq - 1, 1));
        return;
      }
      case "conversation.changed":
        return void background(listConversations());
      case "approval.changed":
        return void background(listApprovals());
      case "read.changed":
        if (event.kind === "conversation") {
          positions.heard(readPath(event.id), event.position);
          return readTo(event.id, event.position);
        }
        positions.heard(seenPath(event.id), event.position);
        return seenTo(event.id, event.position);
      case "session.live":
        return liveNotice(event);
      case "terminal.output":
        return terminalNotice(event);
      case "extensions.changed":
        extensionsNotice();
        return uiResync();
      case "background_command.changed":
        return backgroundNotice(event);
      case "extension.event":
      case "extension.view":
        return uiNotice(event);
      case "session.output": {
        const { session_id, end, type: _, event_id: __, ...tail } = event;
        setOutputs((all) => ({
          ...all,
          [session_id]: { end, at: Date.now() },
        }));
        // How the record now ends rides on the notice: the session updates in place.
        if (Object.keys(tail).length)
          setSessions((ss) =>
            ss.map((s) => (s.id === session_id ? { ...s, ...tail } : s)),
          );
        return;
      }
    }
  }

  // Notices may have been missed: live state, records on screen, terminals, extensions and
  // background commands are read again too.
  function resyncAll() {
    liveResync();
    recordsResync();
    terminalResync();
    extensionsNotice();
    uiResync();
    backgroundResync();
    void background(sync());
  }
  useEffect(() => {
    if (!enabled) return;
    void background(sync());
    return connectRealtime({
      kernel: server,
      event: onEvent,
      sync: resyncAll,
      status: setRealtime,
    });
    // Handlers only use refs and state setters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled]);
  useEffect(() => {
    if (!enabled) return;
    // Back in view, what may have been missed meanwhile is read again: a phone's connection
    // can live through a suspension with its notices lost, and no reconnection says so.
    return whenLooking(() => {
      if (isLooking()) resyncAll();
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled]);

  useEffect(() => {
    outgoing.open();
    return () => outgoing.close();
  }, [outgoing]);
  // What arrived while the person looked away is read when they look again.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => whenLooking(readOpen), []);
  useEffect(() => {
    // Also retried on a timer: the kernel can return without a realtime reconnect.
    if (!enabled || !unsent.length) return;
    const timer = setInterval(() => void outgoing.flush(), 3000);
    return () => clearInterval(timer);
  }, [enabled, unsent.length, outgoing]);

  function select(conversation?: Conversation) {
    open.current = conversation?.id;
    loaded.current = [];
    setMessages([]);
    setOpenId(conversation?.id);
    if (conversation)
      void background(
        readFrom(conversation.id, pageBefore(conversation.last_seq)),
      );
  }
  function replace<T extends { id: string }>(items: T[], item: T) {
    return items.some((i) => i.id === item.id)
      ? items.map((i) => (i.id === item.id ? item : i))
      : [...items, item];
  }

  function applyConversation({ conversation }: { conversation: Conversation }) {
    setConversations((cs) =>
      replace(
        cs,
        mergeConversation(
          cs.find((c) => c.id === conversation.id),
          conversation,
        ),
      ),
    );
  }

  return {
    conversations,
    sessions,
    outputs,
    approvals,
    openId,
    messages,
    realtime,
    error,
    select,
    /** The person saw a session's work up to `at`, in ms, here: their other clients follow. */
    markSeen(sessionId: string, at: number) {
      if (positions.move(seenPath(sessionId), at)) seenTo(sessionId, at);
    },
    async loadEarlier() {
      const id = open.current;
      const first = loaded.current[0]?.seq ?? 1;
      if (id && first > 1)
        await page(id, pageBefore(first - 1), Math.min(PAGE, first - 1));
    },
    unsent,
    canLeave: () => !outgoing.pending() && !waitingInputs.current.size,
    leaveReason: () =>
      waitingInputs.current.size
        ? [...waitingInputs.current.values()].some(
            (i) => i.status === "sending",
          )
          ? "Wait for the Console input to finish sending."
          : "Retry or remove the failed Console input."
        : outgoing.pending()
          ? "Messages are waiting to be sent."
          : undefined,
    send: (conversation: Conversation, draft: { id: string; text: string }) =>
      outgoing.send({ conversation_id: conversation.id, ...draft }),
    async pause(conversation: Conversation, paused: boolean) {
      await order.run(
        "conversations",
        () =>
          api<{ conversation: Conversation }>(
            `/conversations/${conversation.id}/pause`,
            { paused },
          ),
        applyConversation,
      );
    },
    /** The owner closes a thread: its agents stop coordinating there. */
    async close(thread: Conversation) {
      await order.run(
        "conversations",
        () =>
          api<{ conversation: Conversation }>(
            `/conversations/${thread.id}/close`,
            {},
          ),
        applyConversation,
      );
    },
    async create(kind: Conversation["kind"], title: string, members: Member[]) {
      const { conversation } = await order.run(
        "conversations",
        () =>
          api<{ conversation: Conversation }>("/conversations", {
            kind,
            title,
            members,
          }),
        applyConversation,
      );
      // A new chat cannot be stale: it is listed even if a newer list came first.
      setConversations((cs) =>
        cs.some((c) => c.id === conversation.id) ? cs : [...cs, conversation],
      );
      return conversation;
    },
    async addMember(
      conversation: Conversation,
      actor_id: string,
      session_id: string,
    ) {
      await order.run(
        "conversations",
        () =>
          api<{ conversation: Conversation }>(
            `/conversations/${conversation.id}/members`,
            { actor_id, session_id },
          ),
        applyConversation,
      );
    },
    async rename(actorId: string, name: string) {
      await api(`/actors/${actorId}/name`, { name });
    },
    /** What a session is producing right now, before its native record has it. */
    live: (sessionId: string) =>
      api<LiveRead>(`/sessions/${encodeURIComponent(sessionId)}/live`),
    /** The native sessions on this computer, running and saved, that ZeroLux can open. */
    discover: () => api<Discovery>("/sessions/discover"),
    /**
     * Opens a found session in ZeroLux: for an agent (`actor_id`, or a new one by `name`),
     * or as the owner's own with neither.
     */
    async attach(
      discovered_session_id: string,
      agent: { name?: string; actor_id?: string } = {},
    ) {
      const opened = await api<{ actor: Actor | null; session: ChatSession }>(
        "/sessions/attach",
        { discovered_session_id, ...agent },
      );
      await listSessions();
      return opened;
    },
    /** A new session ZeroLux runs in a folder, with or without an agent. */
    async createSession(input: NewSession) {
      const created = await api<{ actor: Actor | null; session: ChatSession }>(
        "/sessions",
        input,
      );
      await listSessions();
      return created;
    },
    /** A new session that goes on from this one, whole or before one of its inputs. */
    async forkSession(sessionId: string, fork: SessionFork = {}) {
      const forked = await api<{ actor: Actor | null; session: ChatSession }>(
        `/sessions/${sessionId}/fork`,
        fork,
      );
      await listSessions();
      return forked;
    },
    /** The session's files as they were before its input at `at`; `dryRun` only says what. */
    rewindFiles: (sessionId: string, at: number, dryRun = false) =>
      api<{ result: FilesRewind }>(`/sessions/${sessionId}/rewind-files`, {
        at,
        dry_run: dryRun,
      }).then(({ result }) => result),
    /** The owner renames, pins or archives a session; what is left out stays. */
    async updateSession(
      sessionId: string,
      /** `budget_usd` 0 takes the budget away; `shared` only its person changes. */
      change: {
        title?: string;
        pinned?: boolean;
        archived?: boolean;
        budget_usd?: number;
        shared?: SessionShare;
      },
    ) {
      await order.run(
        "sessions",
        () => patch<{ session: ChatSession }>(`/sessions/${sessionId}`, change),
        ({ session }) =>
          setSessions((ss) =>
            replace(ss, { ...ss.find((s) => s.id === session.id), ...session }),
          ),
      );
    },
    /** Cooperatively closes an idle terminal pi; recovery preserves its native identity. */
    async takeoverPi(sessionId: string) {
      try {
        await api(`/sessions/${sessionId}/takeover`, {});
      } finally {
        // A lost acknowledgement is not retried; show the authoritative session state.
        await listSessions().catch(() => {});
      }
    },
    /** Resumes a session ZeroLux runs: the same session, in the same permission mode. */
    async resume(sessionId: string) {
      await api(`/sessions/${sessionId}/resume`, {});
      await listSessions();
    },
    /**
     * Stops the turn a session is working on, not the session. True when the harness stopped
     * it; an error says what this harness or integration cannot do.
     */
    async interrupt(sessionId: string) {
      try {
        const { interrupted } = await api<{ interrupted: boolean }>(
          `/sessions/${sessionId}/interrupt`,
          {},
        );
        return interrupted;
      } finally {
        await listSessions().catch(() => {});
      }
    },
    /**
     * Writes the owner's own words into a session as native input, not as a chat message. A
     * session at rest starts a turn with them; a working one takes them into the running turn
     * (`steer`), after it (`queue`), or in place of it (`interrupt`). Images go with them;
     * with images the text may be empty. It shows at the session's end, by `sentInputs`,
     * until the events show it; `after` is where the record shown ends, else the last notice
     * says. A failed one stays there with its error.
     */
    input: (
      sessionId: string,
      text: string,
      mode: InputMode = "steer",
      images: InputImage[] = [],
      after = outputs[sessionId]?.end ?? 0,
    ) =>
      sendInput({
        id: newId(),
        session_id: sessionId,
        text,
        images,
        mode,
        after,
        status: "sending",
      }),
    /**
     * A session's inputs that neither its record nor its queue show yet, failed ones included;
     * `from` is where the events shown start in its record.
     */
    sentInputs: (
      sessionId: string,
      blocks: SessionBlock[],
      queue: QueuedInput[],
      from?: number,
    ) => {
      const unseen = unseenInputs(inputs, sessionId, blocks, queue, from);
      // A late native record can prove that an input reported as failed did arrive.
      for (const input of inputs) {
        if (
          input.session_id === sessionId &&
          input.status === "failed" &&
          !unseen.some((i) => i.id === input.id)
        )
          waitingInputs.current.delete(input.id);
      }
      return unseen;
    },
    /** Sends a failed input again, the same, where it was. */
    async retryInput(id: string) {
      const input = waitingInputs.current.get(id);
      if (input) await sendInput(input);
    },
    /** Lets a failed input go. */
    dropInput(id: string) {
      waitingInputs.current.delete(id);
      setInputs((all) => all.filter((i) => i.id !== id));
    },
    /**
     * Takes one of the owner's inputs out of a session's queue before it runs. Codex allows it;
     * the other harnesses say they do not.
     */
    async removeQueued(sessionId: string, itemId: string) {
      await remove(
        `/sessions/${encodeURIComponent(sessionId)}/queue/${encodeURIComponent(itemId)}`,
      );
    },
    /** Rewrites one of the owner's inputs waiting in a session's queue, where Codex allows it. */
    async editQueued(sessionId: string, itemId: string, text: string) {
      await patch(
        `/sessions/${encodeURIComponent(sessionId)}/queue/${encodeURIComponent(itemId)}`,
        { text },
      );
    },
    /**
     * Starts the harness's own compaction of a session's history, to give its context room
     * again, with what the summary should keep. The session's events show the summary, or
     * why it failed.
     */
    async compact(sessionId: string, instructions?: string) {
      await api(`/sessions/${sessionId}/compact`, {
        instructions: instructions || null,
      });
    },
    async stop(sessionId: string) {
      await order.run(
        "sessions",
        () => api<{ session: ChatSession }>(`/sessions/${sessionId}/stop`, {}),
        ({ session }) => setSessions((ss) => replace(ss, session)),
      );
    },
    /** Allows a permission as far as `scope` says, or denies it with the owner's `reason`. */
    async decide(
      approvalId: string,
      decision: "allow" | "deny",
      how: { scope?: ApprovalScope; reason?: string } = {},
    ) {
      await order.run(
        "approvals",
        () =>
          api<{ approval: Approval }>(
            `/chat/approvals/${approvalId}/decision`,
            { decision, ...how },
          ),
        ({ approval }) => setApprovals((as) => replace(as, approval)),
      );
    },
    async answer(approvalId: string, answer: QuestionAnswer | FormAnswer) {
      await order.run(
        "approvals",
        () =>
          api<{ approval: Approval }>(
            `/chat/approvals/${approvalId}/answer`,
            answer,
          ),
        ({ approval }) => setApprovals((as) => replace(as, approval)),
      );
    },
  };
}
export type Chat = ReturnType<typeof useChat>;
/** Runs an owner action with the shared busy/error state, then refreshes. */
export type Perform = (operation: () => Promise<void>) => Promise<boolean>;
