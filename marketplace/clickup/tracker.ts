/**
 * Projects' tracker for ClickUp, over its REST API: a ZeroLux project is a ClickUp list, its
 * tasks the list's tasks. What each operation does, with any `fetch`.
 */

export const API = "https://api.clickup.com/api/v2";

type Fetch = (url: string, init?: RequestInit) => Promise<Response>;
type Status = { status: string; type: string; orderindex?: number };

/** ClickUp's priorities: 1 urgent, 2 high, 3 normal, 4 low. */
const PRIORITY: Record<string, number> = {
  urgent: 1,
  high: 2,
  medium: 3,
  low: 4,
};
const NAMED: Record<string, string> = {
  urgent: "urgent",
  high: "high",
  normal: "medium",
  low: "low",
};

/** A list's status as a ZeroLux state: by its type, and its name for the ones it names. */
export function status(found: { status: string; type: string }) {
  const name = found.status.toLowerCase();
  if (found.type === "closed" || found.type === "done") return "done";
  if (/cancel/.test(name)) return "cancelled";
  if (/review/.test(name)) return "in_review";
  if (/backlog/.test(name)) return "backlog";
  if (found.type === "open") return "todo";
  return "in_progress";
}

/** The list's status for a ZeroLux state, if it has one that maps to it. */
export function statusFor(statuses: Status[], wanted: string) {
  return statuses.find((found) => status(found) === wanted)?.status;
}

export function operations(token: () => string, call: Fetch = fetch) {
  const ask = async <T>(path: string, init: RequestInit = {}) => {
    if (!token()) throw new Error("Give ClickUp's API token in its settings");
    const response = await call(`${API}${path}`, {
      ...init,
      headers: { authorization: token(), "content-type": "application/json" },
    });
    if (!response.ok) throw new Error(`ClickUp refused (${response.status})`);
    return (await response.json()) as T;
  };
  const fields = async (list: string, task: Record<string, unknown>) => {
    const sent: Record<string, unknown> = {};
    if (typeof task.title === "string") sent.name = task.title;
    if (typeof task.description === "string")
      sent.description = task.description;
    if (typeof task.priority === "string")
      sent.priority = PRIORITY[task.priority] ?? null;
    if ("due" in task)
      sent.due_date =
        typeof task.due === "string"
          ? Date.parse(`${task.due}T00:00:00Z`)
          : null;
    if (typeof task.status === "string") {
      const { statuses } = await ask<{ statuses: Status[] }>(`/list/${list}`);
      const found = statusFor(statuses, task.status);
      if (found) sent.status = found;
    }
    return sent;
  };
  return {
    projects: async () => {
      const lists: { remote_id: string; name: string }[] = [];
      const { teams } = await ask<{ teams: { id: string }[] }>(`/team`);
      for (const team of teams) {
        const { spaces } = await ask<{
          spaces: { id: string; name: string }[];
        }>(`/team/${team.id}/space`);
        for (const space of spaces) {
          const { lists: loose } = await ask<{
            lists: { id: string; name: string }[];
          }>(`/space/${space.id}/list`);
          const { folders } = await ask<{
            folders: { name: string; lists: { id: string; name: string }[] }[];
          }>(`/space/${space.id}/folder`);
          for (const list of loose)
            lists.push({
              remote_id: list.id,
              name: `${space.name} / ${list.name}`,
            });
          for (const folder of folders)
            for (const list of folder.lists)
              lists.push({
                remote_id: list.id,
                name: `${space.name} / ${folder.name} / ${list.name}`,
              });
        }
      }
      return { projects: lists };
    },
    tasks: async (args: { remote_id: string }) => {
      const { tasks } = await ask<{
        tasks: {
          id: string;
          name: string;
          description?: string | null;
          status: { status: string; type: string };
          priority: { priority: string } | null;
          due_date: string | null;
          url: string;
          tags?: { name: string }[];
        }[];
      }>(`/list/${args.remote_id}/task?include_closed=true&subtasks=true`);
      return {
        tasks: tasks.map((task) => ({
          remote_id: task.id,
          title: task.name,
          description: task.description ?? "",
          status: status(task.status),
          priority: task.priority
            ? (NAMED[task.priority.priority] ?? "none")
            : "none",
          labels: (task.tags ?? []).map((tag) => tag.name),
          due: task.due_date
            ? new Date(Number(task.due_date)).toISOString().slice(0, 10)
            : null,
          url: task.url,
        })),
      };
    },
    create: async (args: {
      remote_id: string;
      task: Record<string, unknown>;
    }) => {
      const created = await ask<{ id: string; url: string }>(
        `/list/${args.remote_id}/task`,
        {
          method: "POST",
          body: JSON.stringify(await fields(args.remote_id, args.task)),
        },
      );
      return { remote_id: created.id, url: created.url };
    },
    update: async (args: {
      remote_id: string;
      task_id: string;
      changes: Record<string, unknown>;
    }) => {
      await ask(`/task/${args.task_id}`, {
        method: "PUT",
        body: JSON.stringify(await fields(args.remote_id, args.changes)),
      });
      return {};
    },
    comment: async (args: { task_id: string; text: string }) => {
      await ask(`/task/${args.task_id}/comment`, {
        method: "POST",
        body: JSON.stringify({ comment_text: args.text }),
      });
      return {};
    },
  };
}
