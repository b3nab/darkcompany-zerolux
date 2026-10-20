import { S3Client } from "bun";
import { defineExtension, serve, type Context } from "./zerolux.ts";
import { operations, type Bucket } from "./provider.ts";

let context: Context | undefined;
let client: { key: string; bucket: Bucket } | undefined;

/** The bucket, as the settings say; made again when they change. */
async function bucket(): Promise<Bucket> {
  if (!context) throw new Error("Not started");
  const settings = await context.secrets();
  const text = (key: string) => String(settings[key] ?? "").trim();
  if (!text("bucket")) throw new Error("Choose the bucket in S3's settings");
  const key = JSON.stringify(settings);
  if (client?.key !== key)
    client = {
      key,
      bucket: new S3Client({
        bucket: text("bucket"),
        region: text("region") || undefined,
        endpoint: text("endpoint") || undefined,
        accessKeyId: text("access_key_id") || undefined,
        secretAccessKey: text("secret_access_key") || undefined,
      }) as unknown as Bucket,
    };
  return client.bucket;
}

let current: Bucket | undefined;
const provider = operations(
  () => {
    if (!current) throw new Error("Not started");
    return current;
  },
  () => String(context?.settings.prefix ?? ""),
  () => context?.folder ?? "",
);

await serve(
  defineExtension({
    start(started) {
      context = started;
    },
    settingsChanged() {
      client = undefined;
    },
    implements: [
      {
        point: "zerolux.storage/providers@1",
        name: "s3",
        title: "S3",
        operations: {
          put: async (input: { key: string; path: string }) => {
            current = await bucket();
            return provider.put(input);
          },
          get: async (input: { key: string }) => {
            current = await bucket();
            return provider.get(input);
          },
          delete: async (input: { key: string }) => {
            current = await bucket();
            return provider.delete(input);
          },
        },
      },
    ],
  }),
);
