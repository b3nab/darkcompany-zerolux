/** Storage's provider for an S3 bucket: what each of its operations does, with any client. */
import { join } from "node:path";

/** An object in the bucket, as Bun's S3 client gives it. */
export interface Stored {
  write(data: Blob): Promise<unknown>;
  delete(): Promise<unknown>;
  exists(): Promise<boolean>;
}

export interface Bucket {
  file(key: string): Stored & Blob;
}

/** The object a Storage key is kept as: under the prefix, if any. */
export const objectKey = (prefix: string, key: string) => {
  if (!key || /[\\/]/.test(key) || key.startsWith("."))
    throw new Error("Invalid key");
  const folder = prefix.replace(/^\/+|\/+$/g, "");
  return folder ? `${folder}/${key}` : key;
};

export function operations(
  bucket: () => Bucket,
  prefix: () => string,
  folder: () => string,
) {
  return {
    put: async (input: { key: string; path: string }) => {
      await bucket()
        .file(objectKey(prefix(), input.key))
        .write(Bun.file(input.path));
      return {};
    },
    /** A copy in the extension's folder, which the kernel removes once sent. */
    get: async (input: { key: string }) => {
      const object = bucket().file(objectKey(prefix(), input.key));
      if (!(await object.exists()))
        throw new Error("The file's bytes are not in the bucket");
      const path = join(folder(), `.get-${crypto.randomUUID()}`);
      await Bun.write(path, object);
      return { path, temporary: true };
    },
    delete: async (input: { key: string }) => {
      await bucket().file(objectKey(prefix(), input.key)).delete();
      return {};
    },
  };
}
