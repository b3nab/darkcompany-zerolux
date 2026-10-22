/**
 * Projects' tracker for Plane, cloud or self-hosted, over its REST API: each source is a Plane
 * workspace, its projects Plane's projects and their tasks the work items, live. What each
 * operation does, with any `fetch`.
 */

type Fetch = (url: string, init?: RequestInit) => Promise<Response>;
type State = { id: string; name: string; group: string };
type Named = { id: string; name: string };
type Member = {
  id: string;
  display_name?: string;
  first_name?: string;
  email?: string;
};

/** A source's place: Plane's address and the workspace's slug. */
export interface Config {
  base_url: string;
  workspace: string;
}

/** A Plane state's group as a Projects state, and "review" in its name. */
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

/** Text as Plane's HTML, and back. */
export const html = (text: string) =>
  text
    ? `<p>${text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\n/g, "<br>")}</p>`
    : "";
export const plain = (html: string | null | undefined) =>
  (html ?? "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>\s*<p>/gi, "\n\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .trim();

/** Where people open Plane: its app beside the cloud's API, the same address when hosted. */
export const web = (base: string) =>
  base.replace(/\/+$/, "").replace("://api.plane.so", "://app.plane.so");

interface Item {
  id: string;
  name: string;
  description_html?: string | null;
  description_stripped?: string | null;
  priority: string;
  state: string;
  target_date: string | null;
  sequence_id: number;
  labels?: string[];
  assignees?: string[];
  created_at?: string;
  updated_at?: string;
}

export function operations(
  config: () => Config,
  key: () => string,
  call: Fetch = fetch,
) {
  const base = () =>
    config().base_url.replace(/\/+$/, "") || "https://api.plane.so";
  const ask = async <T>(path: string, init: RequestInit = {}, root = false) => {
    const { workspace } = config();
    if (!workspace || !key())
      throw new Error("Give Plane's workspace and API key");
    const response = await call(
      root
        ? `${base()}/api/v1${path}`
        : `${base()}/api/v1/workspaces/${encodeURIComponent(workspace)}${path}`,
      {
        ...init,
        headers: { "x-api-key": key(), "content-type": "application/json" },
      },
    );
    if (!response.ok) {
      const reason =
        response.status === 404 ? "not found" : String(response.status);
      throw new Error(`Plane refused (${reason})`);
    }
    if (response.status === 204) return undefined as T;
    return (await response.json()) as T;
  };
  type Page<T> = {
    results: T[];
    next_cursor?: string;
    next_page_results?: boolean;
  };
  /** Every page of a list. */
  const all = async <T>(path: string) => {
    const found: T[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 20; page++) {
      const joined = path.includes("?") ? "&" : "?";
      const answer = await ask<Page<T> | T[]>(
        `${path}${joined}per_page=100${cursor ? `&cursor=${cursor}` : ""}`,
      );
      if (Array.isArray(answer)) return answer;
      found.push(...answer.results);
      if (!answer.next_page_results || !answer.next_cursor) break;
      cursor = answer.next_cursor;
    }
    return found;
  };
  const project = (id: string) =>
    ask<{ id: string; identifier: string; name: string }>(`/projects/${id}/`);
  const states = (id: string) => all<State>(`/projects/${id}/states/`);
  const labels = (id: string) => all<Named>(`/projects/${id}/labels/`);
  const members = async () => {
    try {
      return await ask<Member[]>(`/members/`);
    } catch {
      return [] as Member[];
    }
  };
  /** What a project's tasks are read with: its key, states, labels and people. */
  const known = async (id: string) => {
    const [found, foundStates, foundLabels, people] = await Promise.all([
      project(id),
      states(id),
      labels(id),
      members(),
    ]);
    return { project: found, states: foundStates, labels: foundLabels, people };
  };
  const task = (item: Item, at: Awaited<ReturnType<typeof known>>) => {
    const key = `${at.project.identifier}-${item.sequence_id}`;
    return {
      id: item.id,
      key,
      title: item.name,
      description: item.description_stripped ?? plain(item.description_html),
      status: status(at.states.find((state) => state.id === item.state)),
      priority: item.priority || "none",
      labels: (item.labels ?? [])
        .map((id) => at.labels.find((label) => label.id === id)?.name)
        .filter(Boolean),
      due: item.target_date,
      people: (item.assignees ?? []).map((id) => {
        const member = at.people.find((person) => person.id === id);
        return (
          member?.display_name || member?.first_name || member?.email || id
        );
      }),
      url: `${web(base())}/${config().workspace}/browse/${key}/`,
      created_at: item.created_at ? Date.parse(item.created_at) : null,
      updated_at: item.updated_at ? Date.parse(item.updated_at) : null,
    };
  };
  /** A Projects task's fields as Plane's, labels made where they are missing. */
  const fields = async (id: string, given: Record<string, unknown>) => {
    const sent: Record<string, unknown> = {};
    if (typeof given.title === "string") sent.name = given.title;
    if (typeof given.description === "string")
      sent.description_html = html(given.description);
    if (typeof given.priority === "string") sent.priority = given.priority;
    if ("due" in given) sent.target_date = given.due ?? null;
    if (typeof given.status === "string") {
      const state = stateFor(await states(id), given.status);
      if (state) sent.state = state;
    }
    if (Array.isArray(given.labels)) {
      const have = await labels(id);
      const ids: string[] = [];
      for (const name of given.labels as string[]) {
        const found =
          have.find(
            (label) => label.name.toLowerCase() === name.toLowerCase(),
          ) ??
          (await ask<Named>(`/projects/${id}/labels/`, {
            method: "POST",
            body: JSON.stringify({ name }),
          }));
        ids.push(found.id);
      }
      sent.labels = ids;
    }
    return sent;
  };
  return {
    check: async () => {
      const me = await ask<{ email?: string; display_name?: string }>(
        `/users/me/`,
        {},
        true,
      );
      await ask(`/projects/`);
      return { account: me.email ?? me.display_name ?? config().workspace };
    },
    projects: async () => ({
      projects: (
        await all<{
          id: string;
          name: string;
          identifier: string;
          description?: string;
          archived_at?: string | null;
        }>(`/projects/`)
      ).map((found) => ({
        id: found.id,
        key: found.identifier,
        name: found.name,
        description: found.description ?? "",
        archived: Boolean(found.archived_at),
        url: `${web(base())}/${config().workspace}/projects/${found.id}/issues/`,
      })),
    }),
    tasks: async (args: { project: string }) => {
      const at = await known(args.project);
      const items = await all<Item>(`/projects/${args.project}/issues/`);
      return { tasks: items.map((item) => task(item, at)) };
    },
    task: async (args: { project: string; task: string }) => {
      const at = await known(args.project);
      const item = await ask<Item>(
        `/projects/${args.project}/issues/${args.task}/`,
      );
      const comments = await all<{
        id: string;
        comment_html?: string;
        comment_stripped?: string;
        actor_detail?: { display_name?: string };
        created_at: string;
      }>(`/projects/${args.project}/issues/${args.task}/comments/`);
      return {
        ...task(item, at),
        comments: comments.map((comment) => ({
          id: comment.id,
          by: null,
          author: comment.actor_detail?.display_name ?? null,
          text: comment.comment_stripped ?? plain(comment.comment_html),
          at: Date.parse(comment.created_at),
        })),
      };
    },
    create_task: async (args: {
      project: string;
      task: Record<string, unknown>;
    }) => {
      const created = await ask<Item>(`/projects/${args.project}/issues/`, {
        method: "POST",
        body: JSON.stringify(await fields(args.project, args.task)),
      });
      return task(created, await known(args.project));
    },
    update_task: async (args: {
      project: string;
      task: string;
      changes: Record<string, unknown>;
    }) => {
      const updated = await ask<Item>(
        `/projects/${args.project}/issues/${args.task}/`,
        {
          method: "PATCH",
          body: JSON.stringify(await fields(args.project, args.changes)),
        },
      );
      return task(updated, await known(args.project));
    },
    comment: async (args: { project: string; task: string; text: string }) => {
      const made = await ask<{ id: string; created_at: string }>(
        `/projects/${args.project}/issues/${args.task}/comments/`,
        {
          method: "POST",
          body: JSON.stringify({ comment_html: html(args.text) }),
        },
      );
      return {
        id: made.id,
        by: null,
        author: null,
        text: args.text,
        at: Date.parse(made.created_at),
      };
    },
    delete_task: async (args: { project: string; task: string }) => {
      await ask(`/projects/${args.project}/issues/${args.task}/`, {
        method: "DELETE",
      });
      return {};
    },
  };
}
