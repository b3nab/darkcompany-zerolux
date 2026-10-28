import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clean, operations, type Bucket, type Listed } from "./provider.ts";

/** A bucket kept in memory, listed as S3 lists. */
function memory() {
  const objects = new Map<string, Uint8Array>();
  const bucket: Bucket = {
    file(key: string) {
      const blob = new Blob([
        (objects.get(key) ?? new Uint8Array()) as Uint8Array<ArrayBuffer>,
      ]);
      return Object.assign(blob, {
        write: async (data: Blob | string) =>
          void objects.set(
            key,
            typeof data === "string"
              ? new TextEncoder().encode(data)
              : new Uint8Array(await data.arrayBuffer()),
          ),
        delete: async () => void objects.delete(key),
        exists: async () => objects.has(key),
        stat: async () => ({
          size: objects.get(key)?.length ?? 0,
          lastModified: new Date(7),
          type: "",
        }),
      });
    },
    async list({ prefix = "", delimiter, maxKeys = 1000 }) {
      const keys = [...objects.keys()]
        .filter((key) => key.startsWith(prefix))
        .sort();
      const listed: Listed = { contents: [], commonPrefixes: [] };
      const folders = new Set<string>();
      for (const key of keys) {
        const rest = key.slice(prefix.length);
        const cut = delimiter ? rest.indexOf(delimiter) : -1;
        if (cut >= 0 && cut < rest.length - 1) {
          folders.add(prefix + rest.slice(0, cut + 1));
          continue;
        }
        if (cut >= 0) folders.add(prefix + rest);
        listed.contents!.push({ key, size: objects.get(key)!.length });
      }
      listed.commonPrefixes = [...folders].map((folder) => ({
        prefix: folder,
      }));
      listed.contents = listed.contents!.slice(0, maxKeys);
      return listed;
    },
  };
  return { objects, bucket };
}

test("a location shows its bucket's folder as it is, and changes it there", async () => {
  const folder = await mkdtemp(join(tmpdir(), "zl-s3-"));
  try {
    const { objects, bucket } = memory();
    const provider = operations(() => folder);
    const config = { bucket: "b", prefix: "team/" };
    objects.set("team/report.pdf", new Uint8Array([1, 2, 3]));
    objects.set("team/plans/q3.md", new TextEncoder().encode("q3"));
    objects.set("elsewhere.txt", new Uint8Array());
    expect((await provider.list(bucket, config, "")).entries).toEqual([
      { name: "plans", path: "plans", kind: "folder" },
      expect.objectContaining({
        name: "report.pdf",
        path: "report.pdf",
        kind: "file",
        size: 3,
      }),
    ]);
    // Written where it is named, read back as a copy.
    const source = join(folder, "upload");
    await writeFile(source, "notes");
    const written = await provider.write(
      bucket,
      config,
      "plans/notes.txt",
      source,
    );
    expect(written).toMatchObject({
      path: "plans/notes.txt",
      kind: "file",
      size: 5,
    });
    const read = await provider.read(bucket, config, "plans/notes.txt");
    expect(read.temporary).toBe(true);
    expect(await readFile(read.path, "utf8")).toBe("notes");
    // An empty folder stays, as a marker.
    await provider.mkdir(bucket, config, "empty");
    expect(objects.has("team/empty/")).toBe(true);
    expect(await provider.stat(bucket, config, "empty")).toMatchObject({
      kind: "folder",
    });
    expect((await provider.search(bucket, config, "NOTES")).entries).toEqual([
      expect.objectContaining({ path: "plans/notes.txt" }),
    ]);
    // A folder goes with what it holds.
    await provider.delete(bucket, config, "plans");
    expect([...objects.keys()].sort()).toEqual([
      "elsewhere.txt",
      "team/empty/",
      "team/report.pdf",
    ]);
    await expect(provider.stat(bucket, config, "plans")).rejects.toThrow();
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});

test("a path never leaves its location", () => {
  expect(clean(" a / b /")).toBe("a/b");
  expect(() => clean("a/../b")).toThrow();
});
