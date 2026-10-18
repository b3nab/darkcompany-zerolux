import { harnessLabels } from "./client";
import type { MemberTone } from "./presence";
import type { Approval } from "./chat";
import type { Chat } from "./useChat";
/** Where a client opens an item: a chat, or the session itself in the Console. */
export type Place = { chat: string } | { session: string };
type Activity = Pick<Chat, "approvals" | "sessions" | "conversations">;

/** Something that waits for the owner. */
export interface Need {
  key: string;
  /** The agent whose session it is; null for a session of the owner's own. */
  actorId: string | null;
  sessionId: string;
  /** "Permission" or the harness of a stuck session. */
  kind: string;
  title: string;
  /** The chat it belongs to. */
  where?: string;
  since?: number;
  /** A request of the session: a permission is decided in place; a question or a form is
   * answered in its card. */
  approvalId?: string;
  approvalKind?: Approval["kind"];
  place: Place;
}

/** The requests waiting for a person: those of their own sessions, which only they decide. */
export function requestsFor(
  chat: Pick<Chat, "approvals" | "sessions">,
  me: string | undefined,
) {
  const mine = new Set(
    chat.sessions.filter((s) => s.owner_id === me).map((s) => s.id),
  );
  return chat.approvals.filter(
    (a) => a.status === "pending" && mine.has(a.session_id),
  );
}

/** What waits for you: the requests of your sessions, and those of them that need you. */
export function needsYou(chat: Activity, me: string | undefined): Need[] {
  const chatTitle = (id: string) =>
    chat.conversations.find((c) => c.id === id)?.title;
  return [
    ...requestsFor(chat, me).map((a) => ({
      key: a.id,
      actorId: a.actor_id,
      sessionId: a.session_id,
      kind:
        a.kind === "permission"
          ? "Permission"
          : a.kind === "question"
            ? "Question"
            : "Form",
      title: a.summary,
      where: a.conversation_id ? chatTitle(a.conversation_id) : undefined,
      since: a.created_at,
      approvalId: a.id,
      approvalKind: a.kind,
      place: a.conversation_id
        ? { chat: a.conversation_id }
        : { session: a.session_id },
    })),
    ...chat.sessions
      .filter((s) => s.status === "attention" && s.owner_id === me)
      .map((s) => ({
        key: s.id,
        actorId: s.actor_id,
        sessionId: s.id,
        kind: harnessLabels[s.harness],
        title: s.attention_reason ?? "The session needs your attention",
        place: { session: s.id },
      })),
  ];
}

/** Something an agent is doing now. */
export interface Running {
  key: string;
  /** The agent whose session it is; null for a session of the owner's own. */
  actorId: string | null;
  sessionId: string;
  what: string;
  place: Place;
  /** When it started, if the kernel knows. */
  since?: number;
}

/** Agents working in their native sessions. */
export function runningNow(chat: Activity): Running[] {
  return [
    ...chat.sessions
      .filter((s) => s.status === "connected" && s.activity === "working")
      .map((s) => {
        const id = s.activity_conversation_id;
        const title = chat.conversations.find((c) => c.id === id)?.title;
        return {
          key: s.id,
          actorId: s.actor_id,
          sessionId: s.id,
          what: title ? `Answering in ${title}` : s.title,
          place: id && title ? { chat: id } : { session: s.id },
        };
      }),
  ];
}

/** Evening and night: from 18:00 to 05:00. */
const evening = (hour: number) => hour >= 18 || hour < 5;

/** A greeting for the hour. */
export function greeting(hour = new Date().getHours()) {
  if (evening(hour)) return "Good evening";
  return hour < 12 ? "Good morning" : "Good afternoon";
}

/** The home's name for the hour: "Today" by day, "Tonight" in the evening and at night. */
export const homeLabel = (hour = new Date().getHours()) =>
  evening(hour) ? "Tonight" : "Today";

/**
 * The company as a building at night: one window per seat, lit for each person in or agent at
 * work. Lit windows are scattered, as in a real building, and stay put between renders.
 */
export function facade(
  tones: MemberTone[],
  columns = 8,
  rows = 3,
): MemberTone[] {
  const seats = Math.max(
    columns * rows,
    Math.ceil(tones.length / columns) * columns,
  );
  const order = Array.from({ length: seats }, (_, i) => i);
  let seed = 7;
  for (let i = seats - 1; i > 0; i--) {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    const j = seed % (i + 1);
    [order[i], order[j]] = [order[j]!, order[i]!];
  }
  const cells: MemberTone[] = Array.from({ length: seats }, () => "stopped");
  tones.forEach((tone, i) => (cells[order[i]!] = tone));
  return cells;
}
