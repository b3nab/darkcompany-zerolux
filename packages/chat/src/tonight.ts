import { harnessLabels } from "./client";
import type { MemberTone } from "./presence";
import type { Chat } from "./useChat";
import type { Workspace } from "./workspace";

/** Where a client opens an item: a chat, a task in its project, or the agents' sessions. */
export type Place =
  | { chat: string }
  | { project: string; task: string }
  | { team: true };
type Activity = Pick<Chat, "approvals" | "sessions" | "conversations">;

/** Something that waits for the owner. */
export interface Need {
  key: string;
  actorId: string;
  /** "Permission", "Review" or the harness of a stuck session. */
  kind: string;
  title: string;
  /** The chat or project it belongs to. */
  where?: string;
  since?: number;
  /** A permission request: the owner answers it in place. */
  approvalId?: string;
  place: Place;
}

/** Permission requests, tasks in review and sessions that need the owner. */
export function needsYou(workspace: Workspace, chat: Activity): Need[] {
  const chatTitle = (id: string) =>
    chat.conversations.find((c) => c.id === id)?.title;
  const project = (id: string) =>
    workspace.projects.find((p) => p.id === id)?.name;
  return [
    ...chat.approvals
      .filter((a) => a.status === "pending")
      .map((a) => ({
        key: a.id,
        actorId: a.actor_id,
        kind: "Permission",
        title: a.summary,
        where: chatTitle(a.conversation_id),
        since: a.created_at,
        approvalId: a.id,
        place: { chat: a.conversation_id },
      })),
    ...workspace.tasks
      .filter((t) => t.status === "review")
      .map((t) => ({
        key: t.id,
        actorId: t.assignee_id,
        kind: "Review",
        title: t.title,
        where: project(t.project_id),
        since: t.updated_at,
        place: { project: t.project_id, task: t.id },
      })),
    ...chat.sessions
      .filter((s) => s.status === "attention")
      .map((s) => ({
        key: s.id,
        actorId: s.actor_id,
        kind: harnessLabels[s.harness],
        title: s.attention_reason ?? "The session needs your attention",
        place: { team: true } as const,
      })),
  ];
}

/** Something an agent is doing now. */
export interface Running {
  key: string;
  actorId: string;
  what: string;
  place: Place;
  /** When it started, if the kernel knows. */
  since?: number;
}

/** Agents answering in chats and tasks that workers run. */
export function runningNow(workspace: Workspace, chat: Activity): Running[] {
  return [
    ...chat.sessions
      .filter((s) => s.status === "connected" && s.activity === "working")
      .map((s) => {
        const id = s.activity_conversation_id;
        const title = chat.conversations.find((c) => c.id === id)?.title;
        return {
          key: s.id,
          actorId: s.actor_id,
          what: title ? `Answering in ${title}` : s.title,
          place: id && title ? { chat: id } : ({ team: true } as const),
        };
      }),
    ...workspace.tasks
      .filter((t) => t.status === "running")
      .map((t) => ({
        key: t.id,
        actorId: t.assignee_id,
        what: t.title,
        place: { project: t.project_id, task: t.id },
        since: t.updated_at,
      })),
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
