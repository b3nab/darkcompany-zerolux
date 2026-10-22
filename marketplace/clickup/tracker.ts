/**
 * Projects' tracker for ClickUp, over its REST API: each source is what a ClickUp account
 * reaches, its projects the lists of its spaces and folders and their tasks the lists' tasks,
 * live. What each operation does, with any `fetch`.
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

/** A list's status as a Projects state: by its type, and its name for the ones it names. */
export function status(found: { status: string; type: string }) {
  const name = found.status.toLowerCase();
  if (found.type === "closed" || found.type === "done") return "done";
  if (/cancel/.test(name)) return "cancelled";
  if (/review/.test(name)) return "in_review";
  if (/backlog/.test(name)) return "backlog";
  if (found.type === "open") return "todo";
  return "in_progress";
}

/** The list's status for a Projects state, if it has one that maps to it. */
export function statusFor(statuses: Status[], wanted: string) {
  return statuses.find((found) => status(found) === wanted)?.status;
}

interface Task {
  id: string;
  custom_id?: string | null;
  name: string;
  description?: string | null;
  text_content?: string | null;
  status: { status: string; type: string };
  priority: { priority: string } | null;
  due_date: string | null;
  url: string;
  tags?: { name: string }[];
  assignees?: { username?: string; email?: string }[];
  date_created?: string;
  date_updated?: string;
}

const task = (found: Task) => ({
  id: found.id,
  key: found.custom_id || `#${found.id}`,
  title: found.name,
  description: found.text_content ?? found.description ?? "",
  status: status(found.status),
  priority: found.priority
    ? (NAMED[found.priority.priority] ?? "none")
    : "none",
  labels: (found.tags ?? []).map((tag) => tag.name),
  due: found.due_date
    ? new Date(Number(found.due_date)).toISOString().slice(0, 10)
    : null,
  people: (found.assignees ?? []).map(
    (person) => person.username || person.email || "",
  ),
  url: found.url,
  created_at: found.date_created ? Number(found.date_created) : null,
  updated_at: found.date_updated ? Number(found.date_updated) : null,
});

export function operations(token: () => string, call: Fetch = fetch) {
  const ask = async <T>(path: string, init: RequestInit = {}) => {
    if (!token()) throw new Error("Give ClickUp's API token");
    const response = await call(`${API}${path}`, {
      ...init,
      headers: { authorization: token(), "content-type": "application/json" },
    });
    if (!response.ok)
      throw new Error(
        `ClickUp refused (${response.status === 404 ? "not found" : response.status})`,
      );
    return (await response.json()) as T;
  };
  const fields = async (list: string, given: Record<string, unknown>) => {
    const sent: Record<string, unknown> = {};
    if (typeof given.title === "string") sent.name = given.title;
    if (typeof given.description === "string")
      sent.description = given.description;
    if (typeof given.priority === "string")
      sent.priority = PRIORITY[given.priority] ?? null;
    if ("due" in given)
      sent.due_date =
        typeof given.due === "string"
          ? Date.parse(`${given.due}T00:00:00Z`)
          : null;
    if (typeof given.status === "string") {
      const { statuses } = await ask<{ statuses: Status[] }>(`/list/${list}`);
      const found = statusFor(statuses, given.status);
      if (found) sent.status = found;
    }
    if (Array.isArray(given.labels)) sent.tags = given.labels;
    return sent;
  };
  return {
    check: async () => {
      const { user } = await ask<{
        user: { email?: string; username?: string };
      }>(`/user`);
      return { account: user.email ?? user.username ?? null };
    },
    projects: async () => {
      const lists: { id: string; name: string }[] = [];
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
            lists.push({ id: list.id, name: `${space.name} / ${list.name}` });
          for (const folder of folders)
            for (const list of folder.lists)
              lists.push({
                id: list.id,
                name: `${space.name} / ${folder.name} / ${list.name}`,
              });
        }
      }
      return { projects: lists };
    },
    tasks: async (args: { project: string }) => {
      const found: Task[] = [];
      for (let page = 0; page < 20; page++) {
        const { tasks, last_page } = await ask<{
          tasks: Task[];
          last_page?: boolean;
        }>(
          `/list/${args.project}/task?include_closed=true&subtasks=true&page=${page}`,
        );
        found.push(...tasks);
        if (last_page !== false || !tasks.length) break;
      }
      return { tasks: found.map(task) };
    },
    task: async (args: { task: string }) => {
      const found = await ask<Task>(`/task/${args.task}`);
      const { comments } = await ask<{
        comments: {
          id: string;
          comment_text: string;
          date: string;
          user?: { username?: string };
        }[];
      }>(`/task/${args.task}/comment`);
      return {
        ...task(found),
        comments: comments
          .map((comment) => ({
            id: comment.id,
            by: null,
            author: comment.user?.username ?? null,
            text: comment.comment_text,
            at: Number(comment.date),
          }))
          .sort((a, b) => a.at - b.at),
      };
    },
    create_task: async (args: {
      project: string;
      task: Record<string, unknown>;
    }) =>
      task(
        await ask<Task>(`/list/${args.project}/task`, {
          method: "POST",
          body: JSON.stringify(await fields(args.project, args.task)),
        }),
      ),
    update_task: async (args: {
      project: string;
      task: string;
      changes: Record<string, unknown>;
    }) => {
      const { tags, ...rest } = await fields(args.project, args.changes);
      // A task's tags change one by one.
      if (Array.isArray(tags)) {
        const current =
          (await ask<Task>(`/task/${args.task}`)).tags?.map(
            (tag) => tag.name,
          ) ?? [];
        for (const name of current.filter(
          (name) => !(tags as string[]).includes(name),
        ))
          await ask(`/task/${args.task}/tag/${encodeURIComponent(name)}`, {
            method: "DELETE",
          });
        for (const name of (tags as string[]).filter(
          (name) => !current.includes(name),
        ))
          await ask(`/task/${args.task}/tag/${encodeURIComponent(name)}`, {
            method: "POST",
          });
      }
      return task(
        await ask<Task>(`/task/${args.task}`, {
          method: "PUT",
          body: JSON.stringify(rest),
        }),
      );
    },
    comment: async (args: { task: string; text: string }) => {
      const made = await ask<{ id: string | number; date: number }>(
        `/task/${args.task}/comment`,
        {
          method: "POST",
          body: JSON.stringify({ comment_text: args.text }),
        },
      );
      return {
        id: String(made.id),
        by: null,
        author: null,
        text: args.text,
        at: Number(made.date),
      };
    },
    delete_task: async (args: { task: string }) => {
      await ask(`/task/${args.task}`, { method: "DELETE" });
      return {};
    },
  };
}
