import { ApiError } from "./client";
import type { Actor, Harness } from "./client";

export const PAGE = 100;

export interface DiscoveredSession {
  id: string;
  harness: Harness;
  title: string;
  workspace: string;
  last_activity_at: number | null;
  native_session_id: string;
  availability: "attachable" | "attention";
  can_create_context: boolean;
  reason: string | null;
}
export interface Discovery {
  sessions: DiscoveredSession[];
  errors: { harness: Harness; message: string }[];
}
export interface ChatSession {
  id: string;
  actor_id: string;
  harness: Harness;
  native_session_id: string;
  title: string;
  workspace: string;
  status: "connecting" | "connected" | "attention" | "stopped";
  attention_reason: string | null;
  /** What the native session is doing; null when the harness gives no evidence. */
  activity?: "working" | "idle" | null;
  /** The chat the current turn works for: set only when every input of the turn came from it. */
  activity_conversation_id?: string | null;
  /** Messages stored for this session, in every chat, that have not reached it yet. */
  waiting: number;
  /** "owned": a session ZeroLux runs and can resume; "attached": one the owner already had. */
  origin?: "owned" | "attached";
}
export interface Member {
  actor_id: string;
  session_id: string | null;
}
export interface Conversation {
  id: string;
  kind: "dm" | "group" | "thread";
  title: string;
  paused: boolean;
  /** In a thread, only its participants: they write and receive its deliveries. */
  members: Member[];
  last_seq: number;
  /** A thread's chat: everyone in it can read the thread. */
  parent_id?: string | null;
  /** The message of the parent chat the thread is about: one thread per message. */
  root_message_id?: string | null;
  closed_at?: number | null;
  /** The last stored message, or null when the chat is empty. */
  last_message: Pick<Message, "author_id" | "text" | "created_at"> | null;
}
export type DeliveryStatus = "stored" | "uncertain" | "notified" | "read";
export interface Delivery {
  id: string;
  actor_id: string;
  status: DeliveryStatus;
  last_error: string | null;
}
export interface Message {
  id: string;
  conversation_id: string;
  seq: number;
  author_id: string;
  text: string;
  reply_to_delivery_id: string | null;
  created_at: number;
  deliveries: Delivery[];
}
export interface MessagePage {
  messages: Message[];
  next_cursor: number;
  has_more: boolean;
}
export interface Approval {
  id: string;
  actor_id: string;
  session_id: string;
  conversation_id: string;
  delivery_id: string;
  summary: string;
  details: Record<string, unknown>;
  status: "pending" | "decided" | "uncertain" | "delivered" | "resolved";
  decision: "allow" | "deny" | null;
  native_request_id: string;
  created_at: number;
}
export type ChatEvent = { event_id: string } & (
  | {
      type: "message.created";
      conversation_id: string;
      message_id: string;
      seq: number;
    }
  | { type: "conversation.changed"; conversation_id: string }
  | { type: "session.changed"; session_id: string }
  | { type: "delivery.changed"; conversation_id: string; message_id: string }
  | { type: "approval.changed"; approval_id: string }
);

export const sessionLabels: Record<ChatSession["status"], string> = {
  connecting: "Connecting…",
  connected: "Connected",
  attention: "Needs your attention",
  stopped: "Stopped",
};
/** A session's state as the owner reads it; unknown activity is never shown as idle. */
export function sessionState(session: ChatSession): string {
  if (session.status !== "connected") return sessionLabels[session.status];
  if (session.activity === "working") return "Working…";
  if (session.activity === "idle") return "Idle";
  return "Connected · activity unknown";
}
export const deliveryLabels: Record<DeliveryStatus, string> = {
  stored: "Waiting",
  uncertain: "Sent, not confirmed",
  notified: "Delivered",
  read: "Read",
};
/** One mark per message, as in a group chat: saved, everyone has it, everyone read it. */
export type Receipt = "sent" | "delivered" | "read";
export function receipt(deliveries: Delivery[]): Receipt | undefined {
  if (!deliveries.length) return;
  if (deliveries.every((d) => d.status === "read")) return "read";
  if (deliveries.every((d) => d.status === "read" || d.status === "notified"))
    return "delivered";
  return "sent";
}
export const receiptLabels: Record<Receipt, string> = {
  sent: "Sent",
  delivered: "Delivered to everyone",
  read: "Read by everyone",
};
/** A steady color per author; full class names so Tailwind and Uniwind find them here. */
export const authorColors = [
  "text-author-0",
  "text-author-1",
  "text-author-2",
  "text-author-3",
  "text-author-4",
  "text-author-5",
] as const;
export const authorColor = (actorId: string) =>
  authorColors[
    [...actorId].reduce((sum, c) => sum + c.charCodeAt(0), 0) %
      authorColors.length
  ]!;
/** Under the chat title: who is working and what waits, otherwise who is in the chat. */
export function presenceLine(
  conversation: Conversation,
  sessions: ChatSession[],
  name: (actorId: string) => string,
) {
  const session = (m: Member) => sessions.find((s) => s.id === m.session_id);
  const working = conversation.members
    .filter((m) => session(m)?.activity === "working")
    .map((m) => name(m.actor_id));
  const waiting = conversation.members.flatMap((m) => {
    const count = session(m)?.waiting ?? 0;
    return count ? [`${count} waiting for ${name(m.actor_id)}`] : [];
  });
  const notes = [
    ...(working.length ? [`${working.join(", ")} working…`] : []),
    ...waiting,
  ];
  return notes.length
    ? notes.join(" · ")
    : conversation.members.map((m) => name(m.actor_id)).join(", ");
}
/** The connected agents working on this chat now, for the bubble under the last message. */
export const workingIn = (
  conversation: Conversation,
  sessions: ChatSession[],
) =>
  conversation.members
    .filter((m) => {
      const s = sessions.find((s) => s.id === m.session_id);
      return (
        s?.status === "connected" &&
        s.activity === "working" &&
        s.activity_conversation_id === conversation.id
      );
    })
    .map((m) => m.actor_id);
/** Who is working, the same words in the bubble and in the list of chats. */
export const workingLabel = (names: string[]) =>
  `${names.join(", ")} ${names.length === 1 ? "is" : "are"} working`;
/** A chat's line in the list: who works on it or its threads now, else paused, else its last message. */
export function chatPreview(
  conversation: Conversation,
  conversations: Conversation[],
  sessions: ChatSession[],
  name: (actorId: string) => string,
): { text: string; working: boolean } {
  const working = [
    ...new Set(
      [conversation, ...threadsOf(conversation, conversations)].flatMap((c) =>
        workingIn(c, sessions),
      ),
    ),
  ];
  const last = conversation.last_message;
  return {
    text: working.length
      ? workingLabel(working.map(name))
      : conversation.paused
        ? "Paused"
        : last
          ? `${name(last.author_id)}: ${last.text}`
          : presenceLine(conversation, sessions, name),
    working: working.length > 0,
  };
}
/** Agents coordinate in threads under a chat; the chats themselves are the rest. */
export const isThread = (conversation: Conversation) =>
  conversation.kind === "thread";
/** The chats waiting for the owner: a request to answer (in them or a thread of theirs), or an agent that needs attention. */
export function waitingChats(
  conversations: Conversation[],
  approvals: Approval[],
  sessions: ChatSession[],
): Set<string> {
  const chatOf = (id: string) =>
    conversations.find((c) => c.id === id)?.parent_id ?? id;
  const waiting = new Set(
    approvals
      .filter((a) => a.status === "pending")
      .map((a) => chatOf(a.conversation_id)),
  );
  for (const c of conversations)
    if (
      c.members.some(
        (m) =>
          sessions.find((s) => s.id === m.session_id)?.status === "attention",
      )
    )
      waiting.add(chatOf(c.id));
  return waiting;
}
export const chatFilters = {
  all: "All",
  you: "Needs you",
  groups: "Groups",
} as const;
export type ChatFilter = keyof typeof chatFilters;
/** The chats to list, without threads, the latest activity first. */
export function listChats(
  conversations: Conversation[],
  filter: ChatFilter,
  waiting: Set<string>,
) {
  return conversations
    .filter(
      (c) =>
        !isThread(c) &&
        (filter === "you"
          ? waiting.has(c.id)
          : filter === "groups"
            ? c.kind === "group"
            : true),
    )
    .sort(
      (a, b) =>
        (b.last_message?.created_at ?? 0) - (a.last_message?.created_at ?? 0),
    );
}
/** Messages not yet seen in a chat, as far as this device knows. */
export const unreadIn = (
  conversation: Conversation,
  seen: Record<string, number>,
) => Math.max(0, conversation.last_seq - (seen[conversation.id] ?? 0));
/** A chat's threads, open ones first, then the most recent. */
export const threadsOf = (
  conversation: Conversation,
  conversations: Conversation[],
) =>
  conversations
    .filter((c) => c.parent_id === conversation.id)
    .sort(
      (a, b) =>
        Number(!!a.closed_at) - Number(!!b.closed_at) ||
        b.last_seq - a.last_seq,
    );
/** The separator between days of messages. */
export function dayLabel(time: number, now = Date.now()) {
  const day = (t: number) => new Date(t).toDateString();
  if (day(time) === day(now)) return "Today";
  if (day(time) === day(now - 86_400_000)) return "Yesterday";
  return new Date(time).toLocaleDateString(undefined, {
    day: "numeric",
    month: "long",
    year: "numeric",
  });
}
/** A message's time: the hour and minutes. */
export const clockTime = (time: number) =>
  new Date(time).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
/** A time in a list of chats: the hour today, the day before that. */
export const listTime = (time: number, now = Date.now()) =>
  dayLabel(time, now) === "Today"
    ? clockTime(time)
    : new Date(time).toLocaleDateString([], { day: "numeric", month: "short" });
export const approvalLabels: Record<Approval["status"], string> = {
  pending: "Waiting for you",
  decided: "Sending your decision",
  uncertain: "Decision may not have arrived",
  delivered: "Decision delivered",
  resolved: "Closed in the agent's session",
};

const eventTypes = new Set<string>([
  "message.created",
  "conversation.changed",
  "session.changed",
  "delivery.changed",
  "approval.changed",
]);
export function parseEvent(payload: Uint8Array): ChatEvent | undefined {
  try {
    const event = JSON.parse(new TextDecoder().decode(payload)) as ChatEvent;
    if (typeof event.event_id === "string" && eventTypes.has(event.type))
      return event;
  } catch {
    /* Not a chat event. */
  }
}

/** Keep a newer message preview when a list or action response arrives late. */
export function mergeConversation(
  current: Conversation | undefined,
  incoming: Conversation,
): Conversation {
  return current?.id === incoming.id && current.last_seq > incoming.last_seq
    ? {
        ...incoming,
        last_seq: current.last_seq,
        last_message: current.last_message,
      }
    : incoming;
}

/** Merges pages by `seq`, newer copies replacing older ones (e.g. delivery states). */
export function mergeMessages(current: Message[], incoming: Message[]) {
  const bySeq = new Map(current.map((m) => [m.seq, m]));
  for (const message of incoming) bySeq.set(message.seq, message);
  return [...bySeq.values()].sort((a, b) => a.seq - b.seq);
}
export interface Outgoing {
  conversation_id: string;
  id: string;
  text: string;
}
/** Down or restarting (no answer, or a server error): the same request may succeed later. */
const unreachable = (error: unknown) =>
  !(error instanceof ApiError) || error.status >= 500;
/** Messages the kernel has not received yet: resent in order, with the same ID. */
export function outbox(
  post: (message: Outgoing) => Promise<void>,
  changed: (waiting: Outgoing[]) => void,
  refused: (error: unknown) => void,
) {
  let waiting: Outgoing[] = [];
  let flushing: Promise<void> | undefined;
  // Sent, answer pending; and those of them the kernel already showed back.
  const sending = new Set<string>();
  const confirmed = new Set<string>();
  let closed = false;
  const set = (next: Outgoing[]) => changed((waiting = next));
  async function drain() {
    while (waiting.length && !closed) {
      const message = waiting[0]!;
      try {
        await post(message);
      } catch (error) {
        if (unreachable(error)) return;
        refused(error);
      }
      set(waiting.filter((m) => m !== message));
    }
  }
  // A flush asked for during a pass (the kernel is back) gets one more pass, not a no-op.
  let again = false;
  async function passes() {
    do {
      again = false;
      await drain();
    } while (again && !closed);
  }
  const flush = () => {
    if (flushing) again = true;
    return (flushing ??= passes().finally(() => {
      flushing = undefined;
    }));
  };
  return {
    flush,
    /** Connected to its kernel (again, e.g. React re-running effects in development). */
    open() {
      closed = false;
    },
    /** Disconnected from this kernel: a resend already under way stops before the next one. */
    close() {
      closed = true;
    },
    /** The kernel has these already, e.g. its answer to a send was lost: not "not sent". */
    received(ids: string[]) {
      for (const id of ids) if (sending.has(id)) confirmed.add(id);
      if (waiting.some((m) => ids.includes(m.id)))
        set(waiting.filter((m) => !ids.includes(m.id)));
    },
    /** Resolves once the message is sent or kept; throws only when it is refused. */
    async send(message: Outgoing) {
      if (!waiting.length) {
        sending.add(message.id);
        try {
          return await post(message);
        } catch (error) {
          if (!unreachable(error)) throw error;
          // The kernel showed it back before its answer to the send was lost.
          if (confirmed.has(message.id)) return;
        } finally {
          sending.delete(message.id);
          confirmed.delete(message.id);
        }
      }
      set([...waiting, message]);
      void flush();
    },
  };
}
/** A v4 UUID that also works off HTTPS, where `crypto.randomUUID` is missing. */
export function newId() {
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6]! & 0x0f) | 0x40;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
/** Applies a response only if no later request for the same thing has answered. */
export function freshness() {
  let started = 0;
  const applied = new Map<string, number>();
  const accept = (key: string, request: number) => {
    if ((applied.get(key) ?? 0) > request) return false;
    applied.set(key, request);
    return true;
  };
  return {
    start: () => ++started,
    accept,
    /** A read or an action: its result applies unless a later one for `key` already did. */
    async run<T>(
      key: string,
      call: () => Promise<T>,
      apply: (value: T) => void,
    ) {
      const request = ++started;
      const value = await call();
      if (accept(key, request)) apply(value);
      return value;
    },
  };
}
/** Stored and delivered messages move each session's "waiting" count too. */
export const refreshesSessions = (event: ChatEvent) =>
  ["message.created", "delivery.changed", "session.changed"].includes(
    event.type,
  );
/** Found sessions by project folder, keeping their order: which project each belongs to. */
export function byProject(sessions: DiscoveredSession[]) {
  const groups = new Map<string, DiscoveredSession[]>();
  for (const s of sessions)
    groups.set(s.workspace, [...(groups.get(s.workspace) ?? []), s]);
  return [...groups].map(([workspace, list]) => ({
    workspace,
    name: workspace.split(/[\\/]/).filter(Boolean).at(-1) ?? workspace,
    sessions: list,
  }));
}
/** Cursor of the page ending at `lastSeq`: sequences are contiguous from 1. */
export const pageBefore = (lastSeq: number) => Math.max(0, lastSeq - PAGE);

export const agentMembers = (conversation: Conversation, actors: Actor[]) =>
  conversation.members
    .map((m) => actors.find((a) => a.id === m.actor_id))
    .filter((a): a is Actor => a?.kind === "agent");

const sameIds = (a: string[], b: string[]) =>
  a.length === b.length && [...a].sort().join() === [...b].sort().join();
export const sameMembers = (conversation: Conversation, ids: string[]) =>
  sameIds(
    conversation.members.map((m) => m.actor_id),
    ids,
  );

/**
 * What the team list shows: live sessions, those needing attention, and the latest stopped
 * session ZeroLux runs for each native session that is not live again, to resume it.
 */
export const listedSessions = (sessions: ChatSession[]) =>
  sessions.filter(
    (s, i) =>
      s.status !== "stopped" ||
      Boolean(s.attention_reason) ||
      (s.origin === "owned" &&
        !sessions.some(
          (o, j) =>
            o.native_session_id === s.native_session_id &&
            (o.status !== "stopped" || j > i),
        )),
  );

/** An agent's live sessions; any of them may join any chat. */
export const liveSessions = (sessions: ChatSession[], actorId: string) =>
  sessions.filter((s) => s.actor_id === actorId && s.status !== "stopped");
/**
 * The agents a new chat can include: hired, with a live session. A picked one stays listed
 * after its last session stops, so it can be unpicked.
 */
export const agentsForChat = (
  actors: Actor[],
  sessions: ChatSession[],
  picked: string[],
) =>
  actors.filter(
    (a) =>
      a.kind === "agent" &&
      !a.archived &&
      (picked.includes(a.id) || liveSessions(sessions, a.id).length > 0),
  );
/** The direct chat the owner already has with this agent: a new one would repeat it. */
export const directChat = (
  conversations: Conversation[],
  ownerId: string,
  agentId: string,
) =>
  conversations.find(
    (c) => c.kind === "dm" && sameMembers(c, [ownerId, agentId]),
  );

export function ago(time: number, now = Date.now()): string {
  const minutes = Math.round((time - now) / 60_000);
  const [value, unit] =
    Math.abs(minutes) < 60
      ? ([minutes, "minute"] as const)
      : Math.abs(minutes) < 60 * 24
        ? ([Math.round(minutes / 60), "hour"] as const)
        : ([Math.round(minutes / 60 / 24), "day"] as const);
  // Hermes, the phone's engine, has no RelativeTimeFormat: plain English there.
  if (typeof Intl.RelativeTimeFormat === "function")
    return new Intl.RelativeTimeFormat(undefined, { numeric: "auto" }).format(
      value,
      unit,
    );
  if (value === 0) return "now";
  const span = `${Math.abs(value)} ${unit}${Math.abs(value) === 1 ? "" : "s"}`;
  return value < 0 ? `${span} ago` : `in ${span}`;
}
