import {
  defineExtension,
  serve,
} from "../../../../../../packages/extension-sdk/src/index.ts";

type Task = Record<string, unknown> & { id: string; comments: string[] };

// One project, "ENG", with a task already there; what each source's tracker holds.
const tasks: Task[] = [
  {
    id: "t1",
    key: "ENG-1",
    title: "Set up CI",
    description: "",
    status: "todo",
    priority: "high",
    labels: ["ci"],
    due: null,
    people: ["Ana"],
    url: "https://tracker.example/ENG-1",
    updated_at: 1,
    comments: [],
  },
];
const shown = ({ comments: _, ...task }: Task) => task;

await serve(
  defineExtension({
    actions: {
      seen: {
        title: "Seen",
        description: "What the tracker holds",
        run: () => ({ tasks }),
      },
      drop: {
        title: "Drop",
        description: "A task deleted in the tracker, by someone there",
        input: { type: "object", properties: { id: { type: "string" } } },
        run: (input: { id: string }) => {
          tasks.splice(
            tasks.findIndex((task) => task.id === input.id),
            1,
          );
          return {};
        },
      },
    },
    implements: [
      {
        point: "zerolux.projects/trackers@2",
        name: "fake",
        title: "Fake tracker",
        operations: {
          describe: () => ({
            title: "Fake tracker",
            fields: [
              {
                key: "workspace",
                label: "Workspace",
                type: "text",
                required: true,
              },
              { key: "token", label: "Token", type: "secret", required: true },
            ],
            sign_in: false,
            capabilities: ["comments", "labels", "delete"],
          }),
          connect: async (input: any, context) => {
            if (input.config.token !== "right")
              throw new Error("Fake refused (401)");
            await context.vault.set(`source:${input.source}`, {
              token: input.config.token,
            });
            return {
              config: { workspace: input.config.workspace },
              account: "ana@example.com",
            };
          },
          check: () => ({ account: "ana@example.com" }),
          forget: async (input: any, context) => {
            await context.vault.delete(`source:${input.source}`);
            return {};
          },
          projects: async (input: any, context) => {
            if (!(await context.vault.get(`source:${input.source}`)))
              throw new Error("No token");
            return {
              projects: [{ id: "ENG", key: "ENG", name: "Engineering" }],
            };
          },
          tasks: () => ({ tasks: tasks.map(shown) }),
          task: (input: { task: string }) => {
            const task = tasks.find((task) => task.id === input.task);
            if (!task) throw new Error("Fake refused (not found)");
            return {
              ...shown(task),
              comments: task.comments.map((text, i) => ({
                id: String(i),
                by: null,
                author: "Ana",
                text,
                at: i,
              })),
            };
          },
          create_task: (input: { task: Record<string, unknown> }) => {
            const id = `t${tasks.length + 1}`;
            const task = {
              ...input.task,
              id,
              key: `ENG-${tasks.length + 1}`,
              people: [],
              url: null,
              updated_at: 2,
              comments: [],
            };
            tasks.push(task as Task);
            return shown(task as Task);
          },
          update_task: (input: {
            task: string;
            changes: Record<string, unknown>;
          }) => {
            const task = tasks.find((task) => task.id === input.task);
            if (!task) throw new Error("Fake refused (not found)");
            Object.assign(task, input.changes);
            return shown(task);
          },
          comment: (input: { task: string; text: string }) => {
            tasks
              .find((task) => task.id === input.task)
              ?.comments.push(input.text);
            return { id: "c", by: null, author: null, text: input.text, at: 3 };
          },
          delete_task: (input: { task: string }) => {
            tasks.splice(
              tasks.findIndex((task) => task.id === input.task),
              1,
            );
            return {};
          },
        },
      },
    ],
  }),
);
