import { defineExtension, serve, type Context } from "./zerolux.ts";
import { operations, type Drive } from "./provider.ts";

let context: Context | undefined;
let settings: Drive | undefined;

/** Its settings with its secrets, read again before each operation. */
async function read() {
  if (!context) throw new Error("Not started");
  const values = await context.secrets();
  const text = (key: string) => String(values[key] ?? "").trim();
  settings = {
    folder: text("folder_id"),
    clientId: text("client_id"),
    clientSecret: text("client_secret"),
    refreshToken: text("refresh_token"),
  };
}

const provider = operations(
  () => {
    if (!settings) throw new Error("Not started");
    return settings;
  },
  () => context?.folder ?? "",
);

await serve(
  defineExtension({
    start(started) {
      context = started;
    },
    implements: [
      {
        point: "zerolux.storage/providers@1",
        name: "drive",
        title: "Google Drive",
        operations: {
          put: async (input: {
            key: string;
            path: string;
            content_type?: string;
          }) => {
            await read();
            return provider.put(input);
          },
          get: async (input: { key: string }) => {
            await read();
            return provider.get(input);
          },
          delete: async (input: { key: string }) => {
            await read();
            return provider.delete(input);
          },
        },
      },
    ],
  }),
);
