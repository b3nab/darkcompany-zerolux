import {
  defineExtension,
  serve,
} from "../../../../../../packages/extension-sdk/src/index.ts";

// Each location's files, by path, while the process runs.
const disks = new Map<string, Map<string, string>>();
const disk = (location: string) => {
  if (!disks.has(location)) disks.set(location, new Map());
  return disks.get(location)!;
};

await serve(
  defineExtension({
    implements: [
      {
        point: "zerolux.storage/providers@2",
        name: "disk",
        title: "Disk",
        operations: {
          describe: async () => ({
            title: "Disk",
            fields: [
              {
                key: "service",
                label: "Service",
                type: "text",
                required: true,
              },
            ],
            sign_in: true,
            capabilities: ["write", "delete"],
          }),
          connect: async (input: any, context) => {
            const started = await context.oauth.start({
              secret: `location:${input.location}`,
              authorize_url: `${input.config.service}/authorize`,
              token_url: `${input.config.service}/token`,
              client_id: "client-1",
              origin: input.origin,
            });
            return {
              config: { service: input.config.service },
              sign_in: { url: started.url },
            };
          },
          check: async (input: any, context) => {
            await context.oauth.token(`location:${input.location}`);
            return { account: "someone" };
          },
          forget: async () => ({}),
          list: async (input: any, context) => {
            await context.oauth.token(`location:${input.location}`);
            return {
              entries: [...disk(input.location).keys()].map((path) => ({
                name: path,
                path,
                kind: "file",
                size: disk(input.location).get(path)!.length,
              })),
            };
          },
          stat: async (input: any) => {
            const text = disk(input.location).get(input.path);
            if (text === undefined) throw new Error("not there");
            return {
              name: input.path,
              path: input.path,
              kind: "file",
              size: text.length,
            };
          },
          read: async (input: any, context) => {
            const path = `${context.folder}/.read-${crypto.randomUUID()}`;
            await Bun.write(path, disk(input.location).get(input.path) ?? "");
            return { path, temporary: true };
          },
          write: async (input: any) => {
            const text = await Bun.file(input.from).text();
            disk(input.location).set(input.path, text);
            return {
              name: input.path,
              path: input.path,
              kind: "file",
              size: text.length,
            };
          },
          mkdir: async (input: any) => ({
            name: input.path,
            path: input.path,
            kind: "folder",
          }),
          delete: async (input: any) => {
            disk(input.location).delete(input.path);
            return {};
          },
        },
      },
    ],
    on: {
      async "zerolux/signed_in"(payload: any, context) {
        await context.run("zerolux.storage", "signed_in", {
          location: payload.secret.slice("location:".length),
          ok: payload.ok,
          account: "someone",
        });
      },
    },
  }),
);
