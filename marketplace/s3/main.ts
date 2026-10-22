import { S3Client } from "bun";
import { defineExtension, serve, type Context } from "./zerolux.ts";
import { clean, operations, type Bucket, type Config } from "./provider.ts";

let context: Context | undefined;
const provider = operations(() => context?.folder ?? "");

/** A location's keys, kept among the extension's secrets. */
interface Keys {
  secret_access_key?: string;
}

const secretOf = (location: string) => `location:${location}`;

interface Input {
  location: string;
  config: Config;
}

/** The bucket a location is, with its keys. */
async function bucket(input: Input): Promise<Bucket> {
  if (!context) throw new Error("Not started");
  const config = input.config;
  if (!config.bucket) throw new Error("The location has no bucket");
  const keys = (await context.vault.get<Keys>(secretOf(input.location))) ?? {};
  return new S3Client({
    bucket: config.bucket,
    region: config.region || undefined,
    endpoint: config.endpoint || undefined,
    accessKeyId: config.access_key_id || undefined,
    secretAccessKey: keys.secret_access_key || undefined,
  }) as unknown as Bucket;
}

const text = (value: unknown) => String(value ?? "").trim();

await serve(
  defineExtension({
    start(started) {
      context = started;
    },
    implements: [
      {
        point: "zerolux.storage/providers@2",
        name: "s3",
        title: "S3",
        operations: {
          describe: async () => ({
            title: "S3",
            description:
              "A bucket, or a folder of one: Amazon S3, Cloudflare R2, MinIO and the like",
            fields: [
              { key: "bucket", label: "Bucket", type: "text", required: true },
              {
                key: "region",
                label: "Region",
                type: "text",
                description: "us-east-1 when empty",
              },
              {
                key: "endpoint",
                label: "Endpoint",
                type: "text",
                description: "Only for a service other than Amazon S3",
              },
              {
                key: "prefix",
                label: "Folder",
                type: "text",
                description: "A folder of the bucket; all of it when empty",
              },
              {
                key: "access_key_id",
                label: "Access key ID",
                type: "text",
                required: true,
              },
              {
                key: "secret_access_key",
                label: "Secret access key",
                type: "secret",
                required: true,
              },
            ],
            sign_in: false,
            capabilities: ["write", "delete", "search"],
          }),
          connect: async (input: {
            location: string;
            config: Record<string, unknown>;
            previous?: Config;
          }) => {
            if (!context) throw new Error("Not started");
            const given = input.config;
            const previous = input.previous ?? ({} as Config);
            // What is not given again stays as it was.
            const pick = (key: keyof Config) =>
              key in given ? text(given[key]) : text(previous[key]);
            const config: Config = {
              bucket: pick("bucket"),
              region: pick("region"),
              endpoint: pick("endpoint"),
              prefix: clean(pick("prefix")),
              access_key_id: pick("access_key_id"),
            };
            if (!config.bucket) throw new Error("Give the bucket");
            const secret = text(given.secret_access_key);
            const held =
              (await context.vault.get<Keys>(secretOf(input.location))) ?? {};
            const keys: Keys = secret ? { secret_access_key: secret } : held;
            await context.vault.set(secretOf(input.location), keys);
            try {
              const checked = await provider.check(
                await bucket({ location: input.location, config }),
                config,
              );
              return { config, account: checked.account };
            } catch (error) {
              // A location that cannot be reached is not kept, nor are its keys.
              if (!held.secret_access_key)
                await context.vault.delete(secretOf(input.location));
              else await context.vault.set(secretOf(input.location), held);
              throw new Error(
                `The bucket could not be reached: ${(error as Error).message}`,
              );
            }
          },
          check: async (input: Input) =>
            provider.check(await bucket(input), input.config),
          forget: async (input: { location: string }) => {
            await context?.vault.delete(secretOf(input.location));
            return {};
          },
          list: async (input: Input & { path?: string }) =>
            provider.list(await bucket(input), input.config, input.path ?? ""),
          stat: async (input: Input & { path: string }) =>
            provider.stat(await bucket(input), input.config, input.path),
          read: async (input: Input & { path: string }) =>
            provider.read(await bucket(input), input.config, input.path),
          write: async (input: Input & { path: string; from: string }) =>
            provider.write(
              await bucket(input),
              input.config,
              input.path,
              input.from,
            ),
          mkdir: async (input: Input & { path: string }) =>
            provider.mkdir(await bucket(input), input.config, input.path),
          delete: async (input: Input & { path: string }) =>
            provider.delete(await bucket(input), input.config, input.path),
          search: async (input: Input & { query: string }) =>
            provider.search(await bucket(input), input.config, input.query),
        },
      },
    ],
  }),
);
