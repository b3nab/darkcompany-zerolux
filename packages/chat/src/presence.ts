import { liveSessions, sessionState } from "./chat";
import type { ChatSession } from "./chat";
import type { Actor } from "./client";
import type { Chat } from "./useChat";
import { liveConnection } from "./workspace";
import type { AgentConnection, Workspace } from "./workspace";

/** What an actor or session is doing, as one word and a light that agrees with it. */
export type Tone =
  "working" | "connecting" | "connected" | "attention" | "stopped";
/** A member's light: a person is in ("on") or out, an agent has its sessions' tone. */
export type MemberTone = Tone | "on";

/** A session's tone: working while its turn runs, otherwise its connection state. */
export const sessionTone = (session: ChatSession): Tone =>
  session.status === "connected" && session.activity === "working"
    ? "working"
    : session.status;

/**
 * What an agent is doing, as the owner reads it everywhere: its best chat session, else a
 * task worker, else nothing. A connected session wins over one that needs attention or is
 * still connecting, whatever activity that one last reported.
 */
export function agentPresence(
  actorId: string,
  sessions: ChatSession[],
  connections: AgentConnection[],
): { label: string; tone: Tone } {
  const live = sessions.filter(
    (s) => s.actor_id === actorId && s.status !== "stopped",
  );
  const connected = live.filter((s) => s.status === "connected");
  const session =
    connected.find((s) => s.activity === "working") ?? connected[0] ?? live[0];
  if (session)
    return { label: sessionState(session), tone: sessionTone(session) };
  if (liveConnection(connections, actorId))
    return { label: "Task worker connected", tone: "connected" };
  // Still in the organization after Stop: only its session is gone.
  return { label: "Not connected", tone: "stopped" };
}

/** Any member's light; `ownerId` is the person using this client. */
export const memberTone = (
  actor: Actor,
  ownerId: string | undefined,
  sessions: ChatSession[],
  connections: AgentConnection[],
): MemberTone =>
  actor.kind === "human"
    ? // TODO: kernel: presence for people other than the owner using this client.
      actor.id === ownerId
      ? "on"
      : "stopped"
    : agentPresence(actor.id, sessions, connections).tone;

/** What an agent works on now, its one-to-one chat with its owner, and what waits for it. */
export function agentWork(
  agent: Actor,
  workspace: Workspace,
  chat: Pick<Chat, "sessions" | "conversations">,
) {
  const sessions = liveSessions(chat.sessions, agent.id);
  return {
    sessions,
    answering: chat.conversations.find((c) =>
      sessions.some(
        (s) => s.activity === "working" && s.activity_conversation_id === c.id,
      ),
    ),
    task: workspace.tasks.find(
      (t) => t.assignee_id === agent.id && t.status === "running",
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
