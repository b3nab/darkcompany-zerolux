/**
 * Storage's provider for S3 buckets (Amazon S3, Cloudflare R2, MinIO and the like): each
 * location is a bucket, or a folder of one, shown as the bucket holds it. A folder is a key
 * prefix; an empty one is kept as an empty object named with a slash at its end, as S3's own
 * console does. What each operation does, with any client.
 */
import { join } from "node:path";

/** An object, as Bun's S3 client gives it. */
export interface Stored extends Blob {
  write(data: Blob | string): Promise<unknown>;
  delete(): Promise<unknown>;
  exists(): Promise<boolean>;
  stat(): Promise<{ size: number; lastModified: Date; type: string }>;
}

export interface Listed {
  commonPrefixes?: { prefix: string }[];
  contents?: { key: string; size?: number; lastModified?: string }[];
  isTruncated?: boolean;
  nextContinuationToken?: string;
}

export interface Bucket {
  file(key: string): Stored;
  list(options: {
    prefix?: string;
    delimiter?: string;
    maxKeys?: number;
    continuationToken?: string;
  }): Promise<Listed>;
}

/** A location's configuration, as people see it: never its secret key. */
export interface Config {
  bucket: string;
  region?: string;
  endpoint?: string;
  prefix?: string;
  access_key_id?: string;
}

export interface Entry {
  name: string;
  path: string;
  kind: "file" | "folder";
  size?: number;
  modified?: number;
  content_type?: string;
}

/** A path within a location: `a/b`, never leaving it. */
export function clean(path: string) {
  const parts = path
    .split("/")
    .map((part) => part.trim())
    .filter(Boolean);
  if (
    parts.some((part) => part === "." || part === ".." || part.includes("\\"))
  )
    throw new Error("Invalid path");
  return parts.join("/");
}

/** The prefix a location's objects are under: its folder of the bucket, with its slash. */
export const root = (config: Config) => {
  const prefix = clean(config.prefix ?? "");
  return prefix ? `${prefix}/` : "";
};

const leaf = (path: string) => path.slice(path.lastIndexOf("/") + 1);
const join2 = (folder: string, name: string) =>
  folder ? `${folder}/${name}` : name;

/** Every page of a listing. */
async function* pages(bucket: Bucket, options: Parameters<Bucket["list"]>[0]) {
  let token: string | undefined;
  do {
    const page = await bucket.list({ ...options, continuationToken: token });
    yield page;
    token = page.isTruncated ? page.nextContinuationToken : undefined;
  } while (token);
}

export function operations(folder: () => string) {
  const entries = async (bucket: Bucket, config: Config, path: string) => {
    const base = root(config) + (path ? `${path}/` : "");
    const found: Entry[] = [];
    for await (const page of pages(bucket, { prefix: base, delimiter: "/" })) {
      for (const { prefix } of page.commonPrefixes ?? []) {
        const name = prefix.slice(base.length).replace(/\/$/, "");
        if (name) found.push({ name, path: join2(path, name), kind: "folder" });
      }
      for (const object of page.contents ?? []) {
        const name = object.key.slice(base.length);
        // A folder's own marker is not one of its files.
        if (!name || name.endsWith("/")) continue;
        found.push({
          name,
          path: join2(path, name),
          kind: "file",
          size: object.size ?? 0,
          modified: object.lastModified
            ? Date.parse(object.lastModified)
            : undefined,
        });
      }
    }
    return found.sort(
      (a, b) =>
        Number(a.kind !== "folder") - Number(b.kind !== "folder") ||
        a.name.localeCompare(b.name),
    );
  };
  const isFolder = async (bucket: Bucket, config: Config, path: string) => {
    if (!path) return true;
    const page = await bucket.list({
      prefix: `${root(config)}${path}/`,
      maxKeys: 1,
    });
    return Boolean(page.contents?.length || page.commonPrefixes?.length);
  };
  const stat = async (
    bucket: Bucket,
    config: Config,
    path: string,
  ): Promise<Entry> => {
    path = clean(path);
    const object = bucket.file(root(config) + path);
    if (path && (await object.exists())) {
      const stats = await object.stat();
      return {
        name: leaf(path),
        path,
        kind: "file",
        size: stats.size,
        modified: stats.lastModified.getTime(),
        content_type: stats.type || undefined,
      };
    }
    if (await isFolder(bucket, config, path))
      return { name: leaf(path), path, kind: "folder" };
    throw new Error(`\`${path}\` is not there`);
  };
  /** The keys under a folder, or the file's own. */
  const keys = async (bucket: Bucket, config: Config, path: string) => {
    const object = root(config) + path;
    if (path && (await bucket.file(object).exists())) return [object];
    const all: string[] = [];
    for await (const page of pages(bucket, { prefix: `${object}/` }))
      all.push(...(page.contents ?? []).map((content) => content.key));
    return all;
  };
  return {
    check: async (bucket: Bucket, config: Config) => {
      await bucket.list({ prefix: root(config), maxKeys: 1 });
      return { account: config.bucket };
    },
    list: async (bucket: Bucket, config: Config, path: string) => ({
      entries: await entries(bucket, config, clean(path)),
    }),
    stat,
    /** A copy in the extension's folder, which the kernel removes once sent. */
    read: async (bucket: Bucket, config: Config, path: string) => {
      path = clean(path);
      const object = bucket.file(root(config) + path);
      if (!path || !(await object.exists()))
        throw new Error(`\`${path}\` is not a file there`);
      const local = join(folder(), `.read-${crypto.randomUUID()}`);
      await Bun.write(local, object);
      return { path: local, temporary: true };
    },
    write: async (
      bucket: Bucket,
      config: Config,
      path: string,
      from: string,
    ) => {
      path = clean(path);
      if (!path) throw new Error("Name the file");
      await bucket.file(root(config) + path).write(Bun.file(from));
      return stat(bucket, config, path);
    },
    mkdir: async (bucket: Bucket, config: Config, path: string) => {
      path = clean(path);
      if (!(await isFolder(bucket, config, path)))
        await bucket.file(`${root(config)}${path}/`).write("");
      return { name: leaf(path), path, kind: "folder" } as Entry;
    },
    delete: async (bucket: Bucket, config: Config, path: string) => {
      path = clean(path);
      if (!path) throw new Error("The location itself is not deleted");
      for (const key of await keys(bucket, config, path))
        await bucket.file(key).delete();
      // The folder's own marker, if it has one.
      const marker = bucket.file(`${root(config)}${path}/`);
      if (await marker.exists()) await marker.delete();
      return {};
    },
    /** Names that hold the words, in the whole location: up to 200, of 20,000 looked at. */
    search: async (bucket: Bucket, config: Config, query: string) => {
      const words = query.trim().toLowerCase();
      const base = root(config);
      const found: Entry[] = [];
      if (!words) return { entries: found };
      let seen = 0;
      for await (const page of pages(bucket, { prefix: base })) {
        for (const object of page.contents ?? []) {
          if (++seen > 20_000 || found.length >= 200) return { entries: found };
          const path = object.key.slice(base.length).replace(/\/$/, "");
          if (!path || !leaf(path).toLowerCase().includes(words)) continue;
          found.push({
            name: leaf(path),
            path,
            kind: object.key.endsWith("/") ? "folder" : "file",
            size: object.size,
          });
        }
      }
      return { entries: found };
    },
  };
}
