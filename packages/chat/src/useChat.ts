import { useEffect, useRef, useState } from "react";
import { errorMessage, kernelUrl, request } from "./client";
import type { ClaudeMode } from "./client";
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
  ChatEvent,
  ChatSession,
  Conversation,
  Discovery,
  Member,
  Message,
  MessagePage,
  Outgoing,
} from "./chat";
import { connectRealtime } from "./realtime";
import type { RealtimeStatus } from "./realtime";

/** Chat state for the owner: LiveKit events say what to refetch from the kernel. */
export function useChat(enabled: boolean, kernel = kernelUrl()) {
  // Bound for its whole life: what waits for one kernel never goes to another.
  const [server] = useState(kernel);
  const api = <T>(path: string, body?: unknown) =>
    request<T>(server, path, body);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [sessions, setSessions] = useState<ChatSession[]>([]);
  const [approvals, setApprovals] = useState<Approval[]>([]);
  const [openId, setOpenId] = useState<string>();
  const [messages, setMessages] = useState<Message[]>([]);
  const [seen, setSeen] = useState<Record<string, number>>({});
  const [realtime, setRealtime] = useState<RealtimeStatus>("connecting");
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
      () => api<{ sessions: ChatSession[] }>("/chat/sessions"),
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
    }
  }

  useEffect(() => {
    if (!enabled) return;
    void background(sync());
    return connectRealtime({
      kernel: server,
      event: onEvent,
      sync: () => void background(sync()),
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
    discover: () => api<Discovery>("/sessions"),
    async hire(discovered_session_id: string, name: string, actor_id?: string) {
      await api("/chat/hire", { discovered_session_id, name, actor_id });
      await listSessions();
    },
    /** A new Claude Code session ZeroLux runs in a folder: a new agent, or another of one. */
    async startClaude(input: {
      name: string;
      workspace: string;
      permission_mode: ClaudeMode;
      actor_id?: string;
    }) {
      await api("/chat/claude-sessions", input);
      await listSessions();
    },
    /** Resumes a session ZeroLux runs: the same session, in the same permission mode. */
    async resume(sessionId: string) {
      await api(`/chat/sessions/${sessionId}/resume`, {});
      await listSessions();
    },
    async stop(sessionId: string) {
      await order.run(
        "sessions",
        () =>
          api<{ session: ChatSession }>(`/chat/sessions/${sessionId}/stop`, {}),
        ({ session }) => setSessions((ss) => replace(ss, session)),
      );
    },
    async decide(approvalId: string, decision: "allow" | "deny") {
      await order.run(
        "approvals",
        () =>
          api<{ approval: Approval }>(
            `/chat/approvals/${approvalId}/decision`,
            { decision },
          ),
        ({ approval }) => setApprovals((as) => replace(as, approval)),
      );
    },
  };
}
export type Chat = ReturnType<typeof useChat>;
/** Runs an owner action with the shared busy/error state, then refreshes. */
export type Perform = (operation: () => Promise<void>) => Promise<boolean>;
