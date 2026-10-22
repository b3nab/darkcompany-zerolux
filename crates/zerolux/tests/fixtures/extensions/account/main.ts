import {
  defineExtension,
  serve,
} from "../../../../../../packages/extension-sdk/src/index.ts";

const text = { type: "string" };

await serve(
  defineExtension({
    actions: {
      remember: {
        title: "Remember a key",
        description: "Keeps an account's key among its secrets",
        effects: "write",
        input: {
          type: "object",
          required: ["name", "key"],
          properties: { name: text, key: text },
        },
        async run(input: { name: string; key: string }, context) {
          await context.vault.set(`key:${input.name}`, { key: input.key });
          return { names: await context.vault.list("key:") };
        },
      },
      recall: {
        title: "Recall a key",
        description: "Whether an account's key is kept, and its length",
        input: {
          type: "object",
          required: ["name"],
          properties: { name: text },
        },
        async run(input: { name: string }, context) {
          const held = await context.vault.get<{ key: string }>(
            `key:${input.name}`,
          );
          return { kept: !!held, length: held?.key.length ?? 0 };
        },
      },
      forget: {
        title: "Forget a key",
        description: "Lets an account's key go",
        effects: "destructive",
        input: {
          type: "object",
          required: ["name"],
          properties: { name: text },
        },
        async run(input: { name: string }, context) {
          await context.vault.delete(`key:${input.name}`);
          return { names: await context.vault.list("key:") };
        },
      },
      connect: {
        title: "Sign in",
        description: "The address where the person signs in to the service",
        effects: "write",
        input: {
          type: "object",
          required: ["service"],
          properties: { service: text },
        },
        async run(input: { service: string }, context) {
          return context.oauth.start({
            secret: "account:main",
            authorize_url: `${input.service}/authorize`,
            token_url: `${input.service}/token`,
            client_id: "client-1",
            client_secret: "client-secret",
            scopes: ["read", "write"],
            params: { access_type: "offline" },
            origin: context.caller.origin,
          });
        },
      },
      token: {
        title: "Token",
        description: "A valid access token of the account",
        async run(_input: unknown, context) {
          return context.oauth.token("account:main");
        },
      },
      heard: {
        title: "Heard",
        description: "What the last sign-in said",
        async run(_input: unknown, context) {
          return { heard: (await context.values.get("signed_in")) ?? null };
        },
      },
    },
    on: {
      async "zerolux/signed_in"(payload, context) {
        await context.values.set("signed_in", payload);
      },
    },
  }),
);
