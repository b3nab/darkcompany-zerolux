import {
  defineExtension,
  serve,
} from "../../../../../../packages/extension-sdk/src/index.ts";

await serve(
  defineExtension({
    implements: [
      {
        point: "zerolux.notes/stores@1",
        name: "memory",
        title: "Memory",
        operations: {
          async put(input: { key: string; text: string }, context) {
            await context.values.set(`note:${input.key}`, input.text);
            return {};
          },
          async get(input: { key: string }, context) {
            return {
              text: (await context.values.get(`note:${input.key}`)) ?? null,
            };
          },
        },
      },
    ],
    on: {
      "zerolux.notes/saved": async (_payload, context) => {
        const heard = Number((await context.values.get("heard")) ?? 0);
        await context.values.set("heard", heard + 1);
      },
    },
    triggers: [{ on: "event:zerolux.notes/saved", action: "count" }],
    actions: {
      count: {
        title: "Count",
        description: "Counts saved notes, as their trigger runs it",
        effects: "write",
        async run(_input, context) {
          const counted =
            Number((await context.values.get("counted")) ?? 0) + 1;
          await context.values.set("counted", counted);
          return { counted };
        },
      },
      tally: {
        title: "Tally",
        description: "What it heard and counted",
        async run(_input, context) {
          return {
            heard: (await context.values.get("heard")) ?? 0,
            counted: (await context.values.get("counted")) ?? 0,
          };
        },
      },
    },
  }),
);
