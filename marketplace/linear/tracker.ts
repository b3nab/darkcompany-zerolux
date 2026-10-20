/**
 * Projects' tracker for Linear, over its GraphQL API: a ZeroLux project is a Linear team, its
 * tasks the team's issues. What each operation does, with any `fetch`.
 */

export const API = "https://api.linear.app/graphql";

type Fetch = (url: string, init?: RequestInit) => Promise<Response>;
type State = { id: string; name: string; type: string };

/** Linear's priorities: 0 none, 1 urgent, 2 high, 3 medium, 4 low. */
const PRIORITY = ["none", "urgent", "high", "medium", "low"];

/** A Linear state as a ZeroLux one: by its type, and "review" in its name. */
export function status(state: { name: string; type: string }) {
  if (state.type === "started" && /review/i.test(state.name))
    return "in_review";
  return (
    {
      triage: "backlog",
      backlog: "backlog",
      unstarted: "todo",
      started: "in_progress",
      completed: "done",
      canceled: "cancelled",
    }[state.type] ?? "backlog"
  );
}

/** The team's state for a ZeroLux one. */
export function stateFor(states: State[], wanted: string) {
  const type = {
    backlog: "backlog",
    todo: "unstarted",
    in_progress: "started",
    in_review: "started",
    done: "completed",
    cancelled: "canceled",
  }[wanted];
  const ofType = states.filter((state) => state.type === type);
  const review = ofType.find((state) => /review/i.test(state.name));
  if (wanted === "in_review" && review) return review.id;
  return (ofType.find((state) => !/review/i.test(state.name)) ?? ofType[0])?.id;
}

const ISSUE = `id identifier title description priority dueDate url
  state { name type } labels { nodes { name } }`;

export function operations(key: () => string, call: Fetch = fetch) {
  const ask = async <T>(
    query: string,
    variables: Record<string, unknown> = {},
  ) => {
    if (!key()) throw new Error("Give Linear's API key in its settings");
    const response = await call(API, {
      method: "POST",
      headers: { authorization: key(), "content-type": "application/json" },
      body: JSON.stringify({ query, variables }),
    });
    const answer = (await response.json().catch(() => ({}))) as {
      data?: T;
      errors?: { message: string }[];
    };
    if (!response.ok || answer.errors?.length || !answer.data)
      throw new Error(
        `Linear refused: ${answer.errors?.[0]?.message ?? response.status}`,
      );
    return answer.data;
  };
  const states = async (team: string) =>
    (
      await ask<{ team: { states: { nodes: State[] } } }>(
        `query($team: String!) { team(id: $team) { states { nodes { id name type } } } }`,
        { team },
      )
    ).team.states.nodes;
  /** A ZeroLux task's fields as Linear's issue input. */
  const input = async (team: string, task: Record<string, unknown>) => {
    const fields: Record<string, unknown> = {};
    if (typeof task.title === "string") fields.title = task.title;
    if (typeof task.description === "string")
      fields.description = task.description;
    if (typeof task.priority === "string")
      fields.priority = Math.max(0, PRIORITY.indexOf(task.priority));
    if ("due" in task) fields.dueDate = task.due ?? null;
    if (typeof task.status === "string") {
      const state = stateFor(await states(team), task.status);
      if (state) fields.stateId = state;
    }
    return fields;
  };
  return {
    projects: async () => ({
      projects: (
        await ask<{ teams: { nodes: { id: string; name: string }[] } }>(
          `{ teams { nodes { id name } } }`,
        )
      ).teams.nodes.map((team) => ({ remote_id: team.id, name: team.name })),
    }),
    tasks: async (args: { remote_id: string }) => {
      const issues = (
        await ask<{
          team: {
            issues: {
              nodes: {
                id: string;
                title: string;
                description: string | null;
                priority: number;
                dueDate: string | null;
                url: string;
                state: { name: string; type: string };
                labels: { nodes: { name: string }[] };
              }[];
            };
          };
        }>(
          `query($team: String!) { team(id: $team) { issues(first: 250) { nodes { ${ISSUE} } } } }`,
          {
            team: args.remote_id,
          },
        )
      ).team.issues.nodes;
      return {
        tasks: issues.map((issue) => ({
          remote_id: issue.id,
          title: issue.title,
          description: issue.description ?? "",
          status: status(issue.state),
          priority: PRIORITY[issue.priority] ?? "none",
          labels: issue.labels.nodes.map((label) => label.name),
          due: issue.dueDate,
          url: issue.url,
        })),
      };
    },
    create: async (args: {
      remote_id: string;
      task: Record<string, unknown>;
    }) => {
      const created = await ask<{
        issueCreate: { issue: { id: string; url: string } };
      }>(
        `mutation($input: IssueCreateInput!) { issueCreate(input: $input) { issue { id url } } }`,
        {
          input: {
            teamId: args.remote_id,
            ...(await input(args.remote_id, args.task)),
          },
        },
      );
      return {
        remote_id: created.issueCreate.issue.id,
        url: created.issueCreate.issue.url,
      };
    },
    update: async (args: {
      remote_id: string;
      task_id: string;
      changes: Record<string, unknown>;
    }) => {
      await ask(
        `mutation($id: String!, $input: IssueUpdateInput!) { issueUpdate(id: $id, input: $input) { success } }`,
        { id: args.task_id, input: await input(args.remote_id, args.changes) },
      );
      return {};
    },
    comment: async (args: { task_id: string; text: string }) => {
      await ask(
        `mutation($input: CommentCreateInput!) { commentCreate(input: $input) { success } }`,
        { input: { issueId: args.task_id, body: args.text } },
      );
      return {};
    },
  };
}
