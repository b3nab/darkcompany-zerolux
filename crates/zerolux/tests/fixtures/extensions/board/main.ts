import {
  defineExtension,
  serve,
} from "../../../../../../packages/extension-sdk/src/index.ts";

type Card = { id: string; title: string; done: boolean };

const cards = async (context: {
  values: { get<T>(key: string): Promise<T | undefined> };
}) => (await context.values.get<Card[]>("cards")) ?? [];

await serve(
  defineExtension({
    events: { changed: { description: "The board changed" } },
    actions: {
      board: {
        title: "Board",
        description: "The board as a view",
        input: {
          type: "object",
          properties: {
            session_id: { type: "string" },
            conversation_id: { type: "string" },
          },
        },
        async run(input: { session_id?: string }, context) {
          const all = await cards(context);
          return {
            type: "stack",
            children: [
              { type: "heading", text: "Board" },
              ...(input.session_id
                ? [{ type: "text", text: input.session_id, tone: "muted" }]
                : []),
              all.length
                ? {
                    type: "list",
                    items: all.map((card) => ({
                      title: card.title,
                      badge: card.done ? "Done" : undefined,
                      action: { name: "done", input: { id: card.id } },
                    })),
                  }
                : { type: "empty", text: "No cards" },
              { type: "form", action: "add", submit: "Add" },
            ],
          };
        },
      },
      add: {
        title: "Add a card",
        description: "Puts a card on the board",
        effects: "write",
        input: {
          type: "object",
          required: ["title"],
          properties: { title: { type: "string", minLength: 1 } },
        },
        async run(input: { title: string }, context) {
          const all = await cards(context);
          const card = {
            id: String(all.length + 1),
            title: input.title,
            done: false,
          };
          await context.values.set("cards", [...all, card]);
          await context.publish("changed", { id: card.id });
          return card;
        },
      },
      done: {
        title: "Done",
        description: "Marks a card done",
        effects: "write",
        input: {
          type: "object",
          required: ["id"],
          properties: { id: { type: "string" } },
        },
        async run(input: { id: string }, context) {
          const all = (await cards(context)).map((card) =>
            card.id === input.id ? { ...card, done: true } : card,
          );
          await context.values.set("cards", all);
          await context.publish("changed", { id: input.id });
          return { done: input.id };
        },
      },
      pin: {
        title: "Pin to the board",
        description: "Puts a message on the board",
        effects: "write",
        input: {
          type: "object",
          required: ["conversation_id", "message_id"],
          properties: {
            conversation_id: { type: "string" },
            message_id: { type: "string" },
          },
        },
        async run(input: { message_id: string }, context) {
          const all = await cards(context);
          await context.values.set("cards", [
            ...all,
            {
              id: String(all.length + 1),
              title: input.message_id,
              done: false,
            },
          ]);
          return { text: "Pinned" };
        },
      },
      live: {
        title: "Live board",
        description: "The board, kept up to date by the extension",
        input: {
          type: "object",
          properties: { conversation_id: { type: "string" } },
        },
        async run(input: { conversation_id?: string }, context) {
          // Kept up to date: a second later, the view changes on its own.
          setTimeout(() => {
            void context.run("zerolux.board", "tick", input).catch(() => {});
          }, 1000);
          return { type: "text", text: "Live" };
        },
      },
      tick: {
        title: "Tick",
        description: "Sends the live view's next tree",
        input: {
          type: "object",
          properties: { conversation_id: { type: "string" } },
        },
        async run(input: { conversation_id?: string }, context) {
          return context.updateView(
            "live",
            { conversation_id: input.conversation_id },
            { type: "text", text: "Ticked" },
          );
        },
      },
    },
    ui: [
      {
        space: "page",
        name: "board",
        title: "Board",
        icon: "kanban",
        view: {
          kind: "described",
          action: "board",
          refresh_on: ["zerolux.board/changed"],
        },
      },
      {
        space: "session",
        name: "board",
        title: "Board",
        view: { kind: "described", action: "board" },
      },
      {
        space: "chat",
        name: "live",
        title: "Live board",
        view: { kind: "remote", action: "live" },
      },
      {
        space: "settings",
        name: "page",
        title: "Board",
        view: { kind: "web", entry: "ui/index.html" },
      },
      {
        space: "message",
        name: "pin",
        title: "Pin to the board",
        view: { kind: "action", action: "pin" },
      },
    ],
  }),
);
