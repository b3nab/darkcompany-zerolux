/**
 * Projects' tracker for Linear, over its GraphQL API: each source is a Linear workspace, its
 * projects the workspace's teams and their tasks the issues, live. What each operation does,
 * with any `fetch`.
 */

export const API = "https://api.linear.app/graphql";

type Fetch = (url: string, init?: RequestInit) => Promise<Response>;
type State = { id: string; name: string; type: string };

/** Linear's priorities: 0 none, 1 urgent, 2 high, 3 medium, 4 low. */
const PRIORITY = ["none", "urgent", "high", "medium", "low"];

/** A Linear state as a Projects one: by its type, and "review" in its name. */
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

/** The team's state for a Projects one. */
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

const ISSUE = `id identifier title description priority dueDate url createdAt updatedAt
  state { name type } labels { nodes { name } } assignee { name displayName email }`;

interface Issue {
  id: string;
  identifier: string;
  title: string;
  description: string | null;
  priority: number;
  dueDate: string | null;
  url: string;
  createdAt?: string;
  updatedAt?: string;
  state: { name: string; type: string };
  labels: { nodes: { name: string }[] };
  assignee?: { name?: string; displayName?: string; email?: string } | null;
}

const task = (issue: Issue) => ({
  id: issue.id,
  key: issue.identifier,
  title: issue.title,
  description: issue.description ?? "",
  status: status(issue.state),
  priority: PRIORITY[issue.priority] ?? "none",
  labels: issue.labels.nodes.map((label) => label.name),
  due: issue.dueDate,
  people: issue.assignee
    ? [
        issue.assignee.displayName ||
          issue.assignee.name ||
          issue.assignee.email,
      ]
    : [],
  url: issue.url,
  created_at: issue.createdAt ? Date.parse(issue.createdAt) : null,
  updated_at: issue.updatedAt ? Date.parse(issue.updatedAt) : null,
});

export function operations(key: () => string, call: Fetch = fetch) {
  const ask = async <T>(
    query: string,
    variables: Record<string, unknown> = {},
  ) => {
    if (!key()) throw new Error("Give Linear's API key");
    const response = await call(API, {
      method: "POST",
      headers: { authorization: key(), "content-type": "application/json" },
      body: JSON.stringify({ query, variables }),
    });
    const answer = (await response.json().catch(() => ({}))) as {
      data?: T;
      errors?: { message: string }[];
    };
    if (!response.ok || answer.errors?.length || !answer.data) {
      const reason = answer.errors?.[0]?.message ?? String(response.status);
      throw new Error(
        `Linear refused: ${/not found|could not find/i.test(reason) ? "not found" : reason}`,
      );
    }
    return answer.data;
  };
  const states = async (team: string) =>
    (
      await ask<{ team: { states: { nodes: State[] } } }>(
        `query($team: String!) { team(id: $team) { states { nodes { id name type } } } }`,
        { team },
      )
    ).team.states.nodes;
  /** A Projects task's fields as Linear's issue input; only labels the team has. */
  const input = async (team: string, given: Record<string, unknown>) => {
    const fields: Record<string, unknown> = {};
    if (typeof given.title === "string") fields.title = given.title;
    if (typeof given.description === "string")
      fields.description = given.description;
    if (typeof given.priority === "string")
      fields.priority = Math.max(0, PRIORITY.indexOf(given.priority));
    if ("due" in given) fields.dueDate = given.due ?? null;
    if (typeof given.status === "string") {
      const state = stateFor(await states(team), given.status);
      if (state) fields.stateId = state;
    }
    if (Array.isArray(given.labels)) {
      const { team: found } = await ask<{
        team: { labels: { nodes: { id: string; name: string }[] } };
      }>(
        `query($team: String!) { team(id: $team) { labels { nodes { id name } } } }`,
        { team },
      );
      fields.labelIds = (given.labels as string[])
        .map(
          (name) =>
            found.labels.nodes.find(
              (label) => label.name.toLowerCase() === name.toLowerCase(),
            )?.id,
        )
        .filter(Boolean);
    }
    return fields;
  };
  return {
    check: async () => {
      const { viewer } = await ask<{ viewer: { email: string } }>(
        `{ viewer { email } }`,
      );
      return { account: viewer.email };
    },
    projects: async () => ({
      projects: (
        await ask<{
          teams: {
            nodes: {
              id: string;
              name: string;
              key: string;
              description?: string | null;
            }[];
          };
        }>(`{ teams { nodes { id name key description } } }`)
      ).teams.nodes.map((team) => ({
        id: team.id,
        key: team.key,
        name: team.name,
        description: team.description ?? "",
      })),
    }),
    tasks: async (args: { project: string }) => {
      const issues: Issue[] = [];
      let after: string | null = null;
      for (let page = 0; page < 10; page++) {
        const found: {
          team: {
            issues: {
              nodes: Issue[];
              pageInfo: { hasNextPage: boolean; endCursor: string | null };
            };
          };
        } = await ask(
          `query($team: String!, $after: String) { team(id: $team) { issues(first: 250, after: $after) { nodes { ${ISSUE} } pageInfo { hasNextPage endCursor } } } }`,
          { team: args.project, after },
        );
        issues.push(...found.team.issues.nodes);
        if (!found.team.issues.pageInfo.hasNextPage) break;
        after = found.team.issues.pageInfo.endCursor;
      }
      return { tasks: issues.map(task) };
    },
    task: async (args: { project: string; task: string }) => {
      const { issue } = await ask<{
        issue: Issue & {
          comments: {
            nodes: {
              id: string;
              body: string;
              createdAt: string;
              user?: { name?: string; displayName?: string } | null;
            }[];
          };
        };
      }>(
        `query($id: String!) { issue(id: $id) { ${ISSUE} comments { nodes { id body createdAt user { name displayName } } } } }`,
        { id: args.task },
      );
      return {
        ...task(issue),
        comments: issue.comments.nodes
          .map((comment) => ({
            id: comment.id,
            by: null,
            author: comment.user?.displayName || comment.user?.name || null,
            text: comment.body,
            at: Date.parse(comment.createdAt),
          }))
          .sort((a, b) => a.at - b.at),
      };
    },
    create_task: async (args: {
      project: string;
      task: Record<string, unknown>;
    }) => {
      const created = await ask<{ issueCreate: { issue: Issue } }>(
        `mutation($input: IssueCreateInput!) { issueCreate(input: $input) { issue { ${ISSUE} } } }`,
        {
          input: {
            teamId: args.project,
            ...(await input(args.project, args.task)),
          },
        },
      );
      return task(created.issueCreate.issue);
    },
    update_task: async (args: {
      project: string;
      task: string;
      changes: Record<string, unknown>;
    }) => {
      const updated = await ask<{ issueUpdate: { issue: Issue } }>(
        `mutation($id: String!, $input: IssueUpdateInput!) { issueUpdate(id: $id, input: $input) { issue { ${ISSUE} } } }`,
        { id: args.task, input: await input(args.project, args.changes) },
      );
      return task(updated.issueUpdate.issue);
    },
    comment: async (args: { task: string; text: string }) => {
      const made = await ask<{
        commentCreate: { comment: { id: string; createdAt: string } };
      }>(
        `mutation($input: CommentCreateInput!) { commentCreate(input: $input) { comment { id createdAt } } }`,
        { input: { issueId: args.task, body: args.text } },
      );
      return {
        id: made.commentCreate.comment.id,
        by: null,
        author: null,
        text: args.text,
        at: Date.parse(made.commentCreate.comment.createdAt),
      };
    },
    /** Into Linear's trash, where it can be restored. */
    delete_task: async (args: { task: string }) => {
      await ask(`mutation($id: String!) { issueDelete(id: $id) { success } }`, {
        id: args.task,
      });
      return {};
    },
  };
}
