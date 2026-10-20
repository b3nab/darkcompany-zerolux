import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { objectKey, operations, type Bucket } from "./provider.ts";

/** A bucket kept in memory. */
function memory() {
  const objects = new Map<string, Uint8Array>();
  const bucket: Bucket = {
    file(key: string) {
      const blob = new Blob([
        (objects.get(key) ?? new Uint8Array()) as Uint8Array<ArrayBuffer>,
      ]);
      return Object.assign(blob, {
        write: async (data: Blob) =>
          void objects.set(key, new Uint8Array(await data.arrayBuffer())),
        delete: async () => void objects.delete(key),
        exists: async () => objects.has(key),
      });
    },
  };
  return { objects, bucket };
}

test("a file is kept under the prefix, read back as a copy, and deleted", async () => {
  const folder = await mkdtemp(join(tmpdir(), "zl-s3-"));
  try {
    const { objects, bucket } = memory();
    const provider = operations(
      () => bucket,
      () => "/workspace/",
      () => folder,
    );
    const source = join(folder, "upload");
    await writeFile(source, "bytes");
    await provider.put({ key: "f1", path: source });
    expect([...objects.keys()]).toEqual(["workspace/f1"]);
    const got = await provider.get({ key: "f1" });
    expect(got.temporary).toBe(true);
    expect(await readFile(got.path, "utf8")).toBe("bytes");
    await provider.delete({ key: "f1" });
    expect(objects.size).toBe(0);
    await expect(provider.get({ key: "f1" })).rejects.toThrow(
      "not in the bucket",
    );
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});

test("a key never reaches outside its prefix", () => {
  expect(objectKey("", "f1")).toBe("f1");
  expect(() => objectKey("p", "../x")).toThrow();
  expect(() => objectKey("p", "a/b")).toThrow();
});
