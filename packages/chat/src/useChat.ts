import { useEffect, useRef, useState } from "react";
import { errorMessage, kernelUrl, request } from "./client";
import type { Actor } from "./client";
import {
  PAGE,
  freshness,
  mergeConversation,
  mergeMessages,
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
  Outgoing,
  QuestionAnswer,
} from "./chat";
import { liveNotice, liveResync } from "./live";
import type { LiveRead } from "./live";
import { connectRealtime } from "./realtime";
import type { RealtimeStatus } from "./realtime";

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
  const [seen, setSeen] = useState<Record<string, number>>({});
  const [realtime, setRealtime] = useState<RealtimeStatus>("connecting");
  // When each session's native output last grew, as the kernel noticed it.
  const [outputs, setOutputs] = useState<
    Record<string, { end: number; at: number }>
  >({});
  const [error, setError] = useState("");
  const open = useRef<string>(undefined);
  const loaded = useRef<Message[]>([]);
  const listed = useRef(false);
  // An older response never overwrites a newer one (e.g. Working after Idle).
  const [order] = useState(freshness);
  const [unsent, setUnsent] = useState<Outgoing[]>([]);
  const [outgoing] = useState(() =>
    outbox(post, setUnsent, (e) => setError(errorMessage(e))),
  );

  function merge(id: string, incoming: Message[]) {
    outgoing.received(incoming.map((m) => m.id));
    if (open.current !== id) return;
    loaded.current = mergeMessages(loaded.current, incoming);
    setMessages(loaded.current);
    const last = loaded.current.at(-1)?.seq ?? 0;
    setSeen((s) => ({ ...s, [id]: Math.max(s[id] ?? 0, last) }));
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
        // Conversations present at first load start as read; later ones as unread.
        const first = !listed.current;
        listed.current = true;
        setSeen((s) => {
          const next = { ...s };
          for (const c of conversations) next[c.id] ??= first ? c.last_seq : 0;
          return next;
        });
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
      ({ sessions }) => setSessions(sessions),
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
      case "session.live":
        return liveNotice(event);
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

  useEffect(() => {
    if (!enabled) return;
    void background(sync());
    return connectRealtime({
      kernel: server,
      event: onEvent,
      sync: () => {
        // Notices may have been missed meanwhile: live state is read again too.
        liveResync();
        void background(sync());
      },
      status: setRealtime,
    });
    // Handlers only use refs and state setters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled]);

  useEffect(() => {
    outgoing.open();
    return () => outgoing.close();
  }, [outgoing]);
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
    seen,
    realtime,
    error,
    select,
    async loadEarlier() {
      const id = open.current;
      const first = loaded.current[0]?.seq ?? 1;
      if (id && first > 1)
        await page(id, pageBefore(first - 1), Math.min(PAGE, first - 1));
    },
    unsent,
    canLeave: () => !outgoing.pending(),
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
      setSeen((s) => ({ ...s, [conversation.id]: conversation.last_seq }));
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
    /** The owner renames, pins or archives a session; what is left out stays. */
    async updateSession(
      sessionId: string,
      /** `budget_usd` 0 takes the budget away. */
      change: {
        title?: string;
        pinned?: boolean;
        archived?: boolean;
        budget_usd?: number;
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
     * with images the text may be empty. The events show them.
     */
    async input(
      sessionId: string,
      text: string,
      mode: InputMode = "steer",
      images: InputImage[] = [],
    ) {
      await api(`/sessions/${sessionId}/input`, {
        text,
        mode,
        ...(images.length ? { images } : {}),
      });
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
