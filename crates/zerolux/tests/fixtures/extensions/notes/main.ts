import {
  defineExtension,
  serve,
} from "../../../../../../packages/extension-sdk/src/index.ts";

await serve(
  defineExtension({
    points: {
      stores: {
        version: 1,
        description: "Where notes are kept",
        operations: {
          put: { input: { type: "object", required: ["key", "text"] } },
          get: { input: { type: "object", required: ["key"] } },
        },
      },
    },
    events: { saved: { description: "A note was saved" } },
    actions: {
      save: {
        title: "Save a note",
        description: "Keeps a note in the chosen store",
        effects: "write",
        input: {
          type: "object",
          required: ["key", "text"],
          properties: {
            key: { type: "string" },
            text: { type: "string", minLength: 1 },
          },
        },
        async run(input: { key: string; text: string }, context) {
          const store = String(context.settings.store);
          await context.points.call(
            "zerolux.notes/stores@1",
            store,
            "put",
            input,
          );
          await context.publish("saved", { key: input.key });
          return { store, by: context.caller.actor_id ?? context.caller.by };
        },
      },
      read: {
        title: "Read a note",
        description: "Reads a note from the chosen store",
        input: {
          type: "object",
          required: ["key"],
          properties: { key: { type: "string" } },
        },
        async run(input: { key: string }, context) {
          return context.points.call(
            "zerolux.notes/stores@1",
            String(context.settings.store),
            "get",
            input,
          );
        },
      },
      secret: {
        title: "Has a token",
        description: "Whether its secret is set",
        async run(_input, context) {
          return { token: Boolean((await context.secrets()).token) };
        },
      },
    },
  }),
);
