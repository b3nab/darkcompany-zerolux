import { defineExtension, serve, type Context } from "./zerolux.ts";
import { operations } from "./tracker.ts";

let context: Context | undefined;

/** A source's API key, kept among the extension's secrets. */
const secretOf = (source: string) => `source:${source}`;

interface Input {
  source: string;
}

/** The tracker of one source, with its key. */
async function clickup(input: Input) {
  if (!context) throw new Error("Not started");
  const held = await context.vault.get<{ token: string }>(
    secretOf(input.source),
  );
  return operations(() => held?.token ?? "");
}

await serve(
  defineExtension({
    start(started) {
      context = started;
    },
    implements: [
      {
        point: "zerolux.projects/trackers@2",
        name: "clickup",
        title: "ClickUp",
        operations: {
          describe: async () => ({
            title: "ClickUp",
            description:
              "What a ClickUp account reaches: the lists of its spaces and folders, and their tasks",
            fields: [
              {
                key: "token",
                label: "API token",
                type: "secret",
                required: true,
                description:
                  "Your personal token, from ClickUp's settings, under Apps",
              },
            ],
            sign_in: false,
            capabilities: ["comments", "labels", "due", "priority", "delete"],
          }),
          connect: async (input: {
            source: string;
            config: Record<string, unknown>;
          }) => {
            if (!context) throw new Error("Not started");
            const held = await context.vault.get<{ token: string }>(
              secretOf(input.source),
            );
            const key =
              String(input.config.token ?? "").trim() || held?.token || "";
            if (!key) throw new Error("Give the API token");
            const checked = await operations(() => key).check();
            await context.vault.set(secretOf(input.source), { token: key });
            return { config: {}, account: checked.account };
          },
          check: async (input: Input) => (await clickup(input)).check(),
          forget: async (input: Input) => {
            await context?.vault.delete(secretOf(input.source));
            return {};
          },
          projects: async (input: Input) => (await clickup(input)).projects(),
          tasks: async (input: Input & { project: string }) =>
            (await clickup(input)).tasks(input),
          task: async (input: Input & { project: string; task: string }) =>
            (await clickup(input)).task(input),
          create_task: async (
            input: Input & { project: string; task: Record<string, unknown> },
          ) => (await clickup(input)).create_task(input),
          update_task: async (
            input: Input & {
              project: string;
              task: string;
              changes: Record<string, unknown>;
            },
          ) => (await clickup(input)).update_task(input),
          comment: async (input: Input & { task: string; text: string }) =>
            (await clickup(input)).comment(input),
          delete_task: async (input: Input & { task: string }) =>
            (await clickup(input)).delete_task(input),
        },
      },
    ],
  }),
);
