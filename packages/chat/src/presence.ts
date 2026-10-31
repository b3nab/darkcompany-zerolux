import { listedSessions, liveSessions, sessionState } from "./chat";
import type { Approval, ChatSession, DiscoveredSession } from "./chat";
import { harnessLabels } from "./client";
import type { Actor } from "./client";
import type { Chat } from "./useChat";

/** What an actor or session is doing, as one word and a light that agrees with it. */
export type Tone =
  | "working"
  | "connecting"
  | "connected"
  | "attention"
  | "stopped";
/** A member's light: a person is in ("on") or out, an agent has its sessions' tone. */
export type MemberTone = Tone | "on";

/** A session's tone: working while its turn runs, otherwise its connection state. */
export const sessionTone = (session: ChatSession): Tone =>
  session.status === "connected" && session.activity === "working"
    ? "working"
    : session.status;

// Working first, then ready, then what needs you, then what is still starting.
const consoleOrder: Record<Tone, number> = {
  working: 0,
  connected: 1,
  attention: 2,
  connecting: 3,
  stopped: 4,
};
/**
 * The Agent Console's sessions: the live ones, working first, the stopped ones apart, and
 * the ones the owner archived in a list of their own.
 */
export function consoleSessions(sessions: ChatSession[]) {
  const listed = listedSessions(sessions).filter((s) => !s.archived_at);
  return {
    live: listed
      .filter((s) => s.status !== "stopped")
      .sort(
        (a, b) => consoleOrder[sessionTone(a)] - consoleOrder[sessionTone(b)],
      ),
    stopped: listed.filter((s) => s.status === "stopped"),
    archived: sessions
      .filter((s) => s.archived_at)
      .sort((a, b) => b.archived_at! - a.archived_at!),
  };
}

/** The session that delegated work to this one, when it is known here. */
export const delegatedBy = (session: ChatSession, sessions: ChatSession[]) =>
  session.parent_session_id
    ? sessions.find((s) => s.id === session.parent_session_id)
    : undefined;

/** The sessions a session delegated work to, the latest first. */
export const delegatedTo = (sessionId: string, sessions: ChatSession[]) =>
  sessions
    .filter((s) => s.parent_session_id === sessionId)
    .sort((a, b) => b.created_at - a.created_at);

/** Each word typed is in what is known, whatever the case: nothing typed finds everything. */
function typedIn(known: (string | null | undefined)[], query: string) {
  const text = known.join("\n").toLowerCase();
  return query
    .toLowerCase()
    .split(/\s+/)
    .every((word) => text.includes(word));
}

/**
 * Whether a session is one the owner is looking for: each word typed is in its title, agent,
 * folder, harness or latest summary, whatever the case. Nothing typed finds them all.
 */
export function sessionMatches(
  session: ChatSession,
  actors: Actor[],
  query: string,
) {
  return typedIn(
    [
      session.title,
      actors.find((a) => a.id === session.actor_id)?.name,
      session.workspace,
      harnessLabels[session.harness],
      session.summary,
    ],
    query,
  );
}

/** Whether a native session of the project is one the owner is looking for: by its title, folder or harness. */
export const nativeMatches = (session: DiscoveredSession, query: string) =>
  typedIn(
    [session.title, session.workspace, harnessLabels[session.harness]],
    query,
  );

/**
 * What an agent is doing, as the owner reads it everywhere: its best chat session.
 * A connected session wins over one that needs attention or is still connecting,
 * whatever activity that one last reported.
 */
export function agentPresence(
  actorId: string,
  sessions: ChatSession[],
): { label: string; tone: Tone } {
  const live = sessions.filter(
    (s) => s.actor_id === actorId && s.status !== "stopped",
  );
  const connected = live.filter((s) => s.status === "connected");
  const session =
    connected.find((s) => s.activity === "working") ?? connected[0] ?? live[0];
  if (session)
    return { label: sessionState(session), tone: sessionTone(session) };
  // Still in the organization after Stop: only its session is gone.
  return { label: "Not connected", tone: "stopped" };
}

/** Any member's light; `ownerId` is the person using this client. */
export const memberTone = (
  actor: Actor,
  ownerId: string | undefined,
  sessions: ChatSession[],
): MemberTone =>
  actor.kind === "human"
    ? // TODO: kernel: presence for people other than the owner using this client.
      actor.id === ownerId
      ? "on"
      : "stopped"
    : agentPresence(actor.id, sessions).tone;

/** One native session, whichever ZeroLux link it had. */
const native = (s: ChatSession) => `${s.harness}:${s.native_session_id}`;

/**
 * What an agent works on now, its live sessions and the earlier ones worth listing, its chats
 * and its one-to-one chat with its owner, and what waits for it.
 */
export function agentWork(
  agent: Actor,
  chat: Pick<Chat, "sessions" | "conversations">,
) {
  const sessions = liveSessions(chat.sessions, agent.id);
  return {
    sessions,
    // Newest first and once per native session; one that runs again is no longer earlier.
    earlier: listedSessions(chat.sessions)
      .filter(
        (s) =>
          s.actor_id === agent.id &&
          s.status === "stopped" &&
          !sessions.some((l) => native(l) === native(s)),
      )
      .reverse()
      .filter(
        (s, i, all) => all.findIndex((o) => native(o) === native(s)) === i,
      ),
    chats: chat.conversations.filter(
      (c) =>
        c.kind !== "thread" && c.members.some((m) => m.actor_id === agent.id),
    ),
    answering: chat.conversations.find((c) =>
      sessions.some(
        (s) => s.activity === "working" && s.activity_conversation_id === c.id,
      ),
    ),
    dm: chat.conversations.find(
      (c) =>
        c.kind === "dm" &&
        c.members.some((m) => m.actor_id === agent.id) &&
        c.members.some((m) => m.actor_id === agent.owner_id),
    ),
    waiting: sessions.reduce((sum, s) => sum + s.waiting, 0),
  };
}

/**
 * What a session asks of you, one state each, most pressing first: a permission to grant, a
 * question to answer, work going on, a failure, results you have not seen, or nothing.
 */
export type Attention =
  | "approval"
  | "input"
  | "working"
  | "failed"
  | "unseen"
  | "idle";

export const attentionLabels: Record<Attention, string> = {
  approval: "Needs approval",
  input: "Needs input",
  working: "Working",
  failed: "Failed",
  unseen: "New",
  idle: "Idle",
};

export const attentionOrder: Attention[] = [
  "approval",
  "input",
  "working",
  "failed",
  "unseen",
  "idle",
];

/** A session's state for you: what it asks, its work, and whether you have seen its latest. */
export function sessionAttention(
  session: ChatSession,
  approvals: Approval[],
): Attention {
  const pending = approvals.filter(
    (a) => a.session_id === session.id && a.status === "pending",
  );
  if (pending.some((a) => a.kind === "permission")) return "approval";
  if (pending.length) return "input";
  if (session.status === "connected" && session.activity === "working")
    return "working";
  if (session.status === "attention" || session.last_turn === "error")
    return "failed";
  if (session.output_at && session.output_at > (session.seen_at ?? 0))
    return "unseen";
  return "idle";
}

/** Sessions as an inbox: pinned ones first, then what needs you, the most recent within each. */
export function attentionInbox(sessions: ChatSession[], approvals: Approval[]) {
  return sessions
    .map((session) => ({
      session,
      attention: sessionAttention(session, approvals),
    }))
    .sort(
      (a, b) =>
        Number(!!b.session.pinned_at) - Number(!!a.session.pinned_at) ||
        attentionOrder.indexOf(a.attention) -
          attentionOrder.indexOf(b.attention) ||
        (b.session.output_at ?? 0) - (a.session.output_at ?? 0),
    );
}

/** When a session's native output last grew: as the kernel lists it, or as it noticed it live. */
export const sessionOutputAt = (
  chat: Pick<Chat, "outputs">,
  session: ChatSession,
): number | undefined => session.output_at ?? chat.outputs[session.id]?.at;

/** What a session tells you without being asked: it needs you, it failed, or it finished. */
export type SessionNotice = "approval" | "input" | "failed" | "finished";

/** Each running session's state: what notices compare. */
export const sessionAttentions = (
  sessions: ChatSession[],
  approvals: Approval[],
): Record<string, Attention> =>
  Object.fromEntries(
    sessions
      .filter((session) => session.status !== "stopped")
      .map((session) => [session.id, sessionAttention(session, approvals)]),
  );

/**
 * What changed for you between two looks: a session that starts needing you or fails, or
 * stops working. A session met for the first time tells nothing.
 */
export function sessionNotices(
  before: Record<string, Attention>,
  after: Record<string, Attention>,
): { id: string; notice: SessionNotice }[] {
  const notices: { id: string; notice: SessionNotice }[] = [];
  for (const [id, attention] of Object.entries(after)) {
    const was = before[id];
    if (was === undefined || was === attention) continue;
    if (
      attention === "approval" ||
      attention === "input" ||
      attention === "failed"
    )
      notices.push({ id, notice: attention });
    else if (was === "working" && attention !== "working")
      notices.push({ id, notice: "finished" });
  }
  return notices;
}

const noticeVerbs: Record<SessionNotice, string> = {
  approval: "asks for approval",
  input: "asks you",
  failed: "needs attention",
  finished: "finished",
};

/** A notice as a notification says it: who and what in the title, the gist below. */
export function noticeText(
  notice: SessionNotice,
  session: ChatSession,
  approvals: Approval[],
  name: string,
): { title: string; body: string } {
  const asks = approvals.find(
    (a) => a.session_id === session.id && a.status === "pending",
  );
  const body =
    notice === "approval" || notice === "input"
      ? asks?.summary
      : notice === "failed"
        ? (session.attention_reason ?? undefined)
        : (session.summary ?? undefined);
  return {
    title: `${name} ${noticeVerbs[notice]}`,
    body: body || session.title || "",
  };
}

/**
 * Sessions as the Console lists them, each one another session started right after it, one
 * level deeper and in its own order, however deep; the others keep their order. One whose
 * coordinator is not in the same list stays where it is, at the top.
 */
export function nestDelegates<T extends { session: ChatSession }>(
  rows: T[],
): (T & { depth: number })[] {
  const listed = new Set(rows.map((row) => row.session.id));
  const under = new Map<string, T[]>();
  const top: T[] = [];
  for (const row of rows) {
    const parent = row.session.parent_session_id;
    if (parent && parent !== row.session.id && listed.has(parent))
      under.set(parent, [...(under.get(parent) ?? []), row]);
    else top.push(row);
  }
  const nested: (T & { depth: number })[] = [];
  const placed = new Set<string>();
  const place = (row: T, depth: number) => {
    if (placed.has(row.session.id)) return;
    placed.add(row.session.id);
    nested.push({ ...row, depth });
    for (const child of under.get(row.session.id) ?? [])
      place(child, depth + 1);
  };
  top.forEach((row) => place(row, 0));
  // Sessions that started each other in a ring have no top: they stay, at the top.
  rows.forEach((row) => place(row, 0));
  return nested;
}
