import { defineExtension, serve, type Context } from "./zerolux.ts";
import { operations } from "./tracker.ts";

let context: Context | undefined;

/** A source's API key, kept among the extension's secrets. */
const secretOf = (source: string) => `source:${source}`;

interface Input {
  source: string;
}

/** The tracker of one source, with its key. */
async function linear(input: Input) {
  if (!context) throw new Error("Not started");
  const held = await context.vault.get<{ api_key: string }>(
    secretOf(input.source),
  );
  return operations(() => held?.api_key ?? "");
}

await serve(
  defineExtension({
    start(started) {
      context = started;
    },
    implements: [
      {
        point: "zerolux.projects/trackers@2",
        name: "linear",
        title: "Linear",
        operations: {
          describe: async () => ({
            title: "Linear",
            description: "A Linear workspace: its teams and their issues",
            fields: [
              {
                key: "api_key",
                label: "API key",
                type: "secret",
                required: true,
                description: "From Linear's settings, under Security & access",
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
            const held = await context.vault.get<{ api_key: string }>(
              secretOf(input.source),
            );
            const key =
              String(input.config.api_key ?? "").trim() || held?.api_key || "";
            if (!key) throw new Error("Give the API key");
            const checked = await operations(() => key).check();
            await context.vault.set(secretOf(input.source), { api_key: key });
            return { config: {}, account: checked.account };
          },
          check: async (input: Input) => (await linear(input)).check(),
          forget: async (input: Input) => {
            await context?.vault.delete(secretOf(input.source));
            return {};
          },
          projects: async (input: Input) => (await linear(input)).projects(),
          tasks: async (input: Input & { project: string }) =>
            (await linear(input)).tasks(input),
          task: async (input: Input & { project: string; task: string }) =>
            (await linear(input)).task(input),
          create_task: async (
            input: Input & { project: string; task: Record<string, unknown> },
          ) => (await linear(input)).create_task(input),
          update_task: async (
            input: Input & {
              project: string;
              task: string;
              changes: Record<string, unknown>;
            },
          ) => (await linear(input)).update_task(input),
          comment: async (input: Input & { task: string; text: string }) =>
            (await linear(input)).comment(input),
          delete_task: async (input: Input & { task: string }) =>
            (await linear(input)).delete_task(input),
        },
      },
    ],
  }),
);
