import {
  defineExtension,
  serve,
} from "../../../../../../packages/extension-sdk/src/index.ts";

type Task = Record<string, unknown> & { remote_id: string; comments: string[] };

// One project, "ENG", with a task already there.
const tasks: Task[] = [
  {
    remote_id: "ENG-1",
    title: "Set up CI",
    description: "",
    status: "todo",
    priority: "high",
    labels: ["ci"],
    due: null,
    url: "https://tracker.example/ENG-1",
    comments: [],
  },
];

await serve(
  defineExtension({
    actions: {
      seen: {
        title: "Seen",
        description: "What the tracker holds",
        run: () => ({ tasks }),
      },
    },
    implements: [
      {
        point: "zerolux.projects/trackers@1",
        name: "fake",
        title: "Fake tracker",
        operations: {
          projects: () => ({
            projects: [{ remote_id: "ENG", name: "Engineering" }],
          }),
          tasks: () => ({
            tasks: tasks.map(({ comments: _, ...task }) => task),
          }),
          create: (input: { task: Record<string, unknown> }) => {
            const remote_id = `ENG-${tasks.length + 1}`;
            const url = `https://tracker.example/${remote_id}`;
            tasks.push({ ...input.task, remote_id, url, comments: [] });
            return { remote_id, url };
          },
          update: (input: {
            task_id: string;
            changes: Record<string, unknown>;
          }) => {
            const task = tasks.find((task) => task.remote_id === input.task_id);
            if (!task) throw new Error("No such task in the tracker");
            Object.assign(task, input.changes);
            return {};
          },
          comment: (input: { task_id: string; text: string }) => {
            tasks
              .find((task) => task.remote_id === input.task_id)
              ?.comments.push(input.text);
            return {};
          },
        },
      },
    ],
  }),
);
