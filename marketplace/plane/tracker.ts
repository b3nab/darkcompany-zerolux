/**
 * Projects' tracker for Plane, over its REST API: a ZeroLux project is a Plane project, its
 * tasks the project's work items. What each operation does, with any `fetch`.
 */

type Fetch = (url: string, init?: RequestInit) => Promise<Response>;
type State = { id: string; name: string; group: string };

export interface Plane {
  baseUrl: string;
  workspace: string;
  key: string;
}

/** A Plane state's group as a ZeroLux state, and "review" in its name. */
export function status(state: { name: string; group: string } | undefined) {
  if (!state) return "backlog";
  if (state.group === "started" && /review/i.test(state.name))
    return "in_review";
  return (
    {
      backlog: "backlog",
      unstarted: "todo",
      started: "in_progress",
      completed: "done",
      cancelled: "cancelled",
    }[state.group] ?? "backlog"
  );
}

export function stateFor(states: State[], wanted: string) {
  const group = {
    backlog: "backlog",
    todo: "unstarted",
    in_progress: "started",
    in_review: "started",
    done: "completed",
    cancelled: "cancelled",
  }[wanted];
  const ofGroup = states.filter((state) => state.group === group);
  const review = ofGroup.find((state) => /review/i.test(state.name));
  if (wanted === "in_review" && review) return review.id;
  return (ofGroup.find((state) => !/review/i.test(state.name)) ?? ofGroup[0])
    ?.id;
}

/** Text as Plane's HTML description, and back. */
const html = (text: string) =>
  text
    ? `<p>${text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\n/g, "<br>")}</p>`
    : "";

export function operations(plane: () => Plane, call: Fetch = fetch) {
  const ask = async <T>(path: string, init: RequestInit = {}) => {
    const settings = plane();
    if (!settings.workspace || !settings.key)
      throw new Error("Give Plane's workspace and API key in its settings");
    const base = settings.baseUrl.replace(/\/+$/, "") || "https://api.plane.so";
    const response = await call(
      `${base}/api/v1/workspaces/${encodeURIComponent(settings.workspace)}${path}`,
      {
        ...init,
        headers: {
          "x-api-key": settings.key,
          "content-type": "application/json",
        },
      },
    );
    if (!response.ok) throw new Error(`Plane refused (${response.status})`);
    return (await response.json()) as T;
  };
  type Page<T> = { results: T[] };
  const states = async (project: string) =>
    (await ask<Page<State>>(`/projects/${project}/states/`)).results;
  const fields = async (project: string, task: Record<string, unknown>) => {
    const sent: Record<string, unknown> = {};
    if (typeof task.title === "string") sent.name = task.title;
    if (typeof task.description === "string")
      sent.description_html = html(task.description);
    if (typeof task.priority === "string") sent.priority = task.priority;
    if ("due" in task) sent.target_date = task.due ?? null;
    if (typeof task.status === "string") {
      const state = stateFor(await states(project), task.status);
      if (state) sent.state = state;
    }
    return sent;
  };
  return {
    projects: async () => ({
      projects: (
        await ask<Page<{ id: string; name: string }>>(`/projects/`)
      ).results.map((project) => ({
        remote_id: project.id,
        name: project.name,
      })),
    }),
    tasks: async (args: { remote_id: string }) => {
      const known = await states(args.remote_id);
      const items = (
        await ask<
          Page<{
            id: string;
            name: string;
            description_stripped?: string | null;
            priority: string;
            state: string;
            target_date: string | null;
            labels?: string[];
          }>
        >(`/projects/${args.remote_id}/issues/?per_page=100`)
      ).results;
      return {
        tasks: items.map((item) => ({
          remote_id: item.id,
          title: item.name,
          description: item.description_stripped ?? "",
          status: status(known.find((state) => state.id === item.state)),
          priority: item.priority || "none",
          due: item.target_date,
          url: null,
        })),
      };
    },
    create: async (args: {
      remote_id: string;
      task: Record<string, unknown>;
    }) => {
      const created = await ask<{ id: string }>(
        `/projects/${args.remote_id}/issues/`,
        {
          method: "POST",
          body: JSON.stringify(await fields(args.remote_id, args.task)),
        },
      );
      return { remote_id: created.id, url: null };
    },
    update: async (args: {
      remote_id: string;
      task_id: string;
      changes: Record<string, unknown>;
    }) => {
      await ask(`/projects/${args.remote_id}/issues/${args.task_id}/`, {
        method: "PATCH",
        body: JSON.stringify(await fields(args.remote_id, args.changes)),
      });
      return {};
    },
    comment: async (args: {
      remote_id: string;
      task_id: string;
      text: string;
    }) => {
      await ask(
        `/projects/${args.remote_id}/issues/${args.task_id}/comments/`,
        {
          method: "POST",
          body: JSON.stringify({ comment_html: html(args.text) }),
        },
      );
      return {};
    },
  };
}
