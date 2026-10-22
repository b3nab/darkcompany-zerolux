import { defineExtension, serve, type Context } from "./zerolux.ts";
import { operations, type Config } from "./tracker.ts";

let context: Context | undefined;

/** A source's API key, kept among the extension's secrets. */
const secretOf = (source: string) => `source:${source}`;
const text = (value: unknown) => String(value ?? "").trim();

interface Input {
  source: string;
  config: Config;
}

/** The tracker of one source, with its key. */
async function plane(input: Input) {
  if (!context) throw new Error("Not started");
  const held = await context.vault.get<{ api_key: string }>(
    secretOf(input.source),
  );
  return operations(
    () => input.config,
    () => held?.api_key ?? "",
  );
}

await serve(
  defineExtension({
    start(started) {
      context = started;
    },
    implements: [
      {
        point: "zerolux.projects/trackers@2",
        name: "plane",
        title: "Plane",
        operations: {
          describe: async () => ({
            title: "Plane",
            description:
              "A Plane workspace, cloud or self-hosted: its projects and work items",
            fields: [
              {
                key: "base_url",
                label: "Address",
                type: "text",
                description: "Only for a Plane you host",
              },
              {
                key: "workspace",
                label: "Workspace",
                type: "text",
                required: true,
                description: "Its slug, as in its address",
              },
              {
                key: "api_key",
                label: "API key",
                type: "secret",
                required: true,
              },
            ],
            sign_in: false,
            capabilities: ["comments", "labels", "due", "priority", "delete"],
          }),
          connect: async (input: {
            source: string;
            config: Record<string, unknown>;
            previous?: Partial<Config>;
          }) => {
            if (!context) throw new Error("Not started");
            const given = input.config;
            const previous = input.previous ?? {};
            const pick = (key: keyof Config) =>
              key in given ? text(given[key]) : text(previous[key]);
            const config: Config = {
              base_url: pick("base_url") || "https://api.plane.so",
              workspace: pick("workspace"),
            };
            if (!config.workspace) throw new Error("Give the workspace's slug");
            const held = await context.vault.get<{ api_key: string }>(
              secretOf(input.source),
            );
            const key = text(given.api_key) || held?.api_key || "";
            if (!key) throw new Error("Give the API key");
            const checked = await operations(
              () => config,
              () => key,
            ).check();
            await context.vault.set(secretOf(input.source), { api_key: key });
            return { config, account: checked.account };
          },
          check: async (input: Input) => (await plane(input)).check(),
          forget: async (input: { source: string }) => {
            await context?.vault.delete(secretOf(input.source));
            return {};
          },
          projects: async (input: Input) => (await plane(input)).projects(),
          tasks: async (input: Input & { project: string }) =>
            (await plane(input)).tasks(input),
          task: async (input: Input & { project: string; task: string }) =>
            (await plane(input)).task(input),
          create_task: async (
            input: Input & { project: string; task: Record<string, unknown> },
          ) => (await plane(input)).create_task(input),
          update_task: async (
            input: Input & {
              project: string;
              task: string;
              changes: Record<string, unknown>;
            },
          ) => (await plane(input)).update_task(input),
          comment: async (
            input: Input & { project: string; task: string; text: string },
          ) => (await plane(input)).comment(input),
          delete_task: async (
            input: Input & { project: string; task: string },
          ) => (await plane(input)).delete_task(input),
        },
      },
    ],
  }),
);
