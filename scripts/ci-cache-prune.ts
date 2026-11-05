// The repository's caches no run restores again, deleted after each CI and Release run so that
// GitHub's limit keeps the ones in use, the nightly's among them: an entry a newer one of its
// kind replaced on its branch, and a tag's, which only that tag's run reads.
import { execFileSync } from "node:child_process";

export interface Cache {
  id: number;
  key: string;
  ref: string;
  createdAt: string;
  sizeInBytes: number;
}

/** A key without its hashes and versions: what a newer entry of the same kind changes. */
const kind = (key: string) =>
  key
    .split("-")
    .filter(
      (part) => !/^[0-9a-f]{8,}$/.test(part) && !/^v?\d+(\.\d+)+$/.test(part),
    )
    .join("-");

export function stale(caches: Cache[]): Cache[] {
  const newest = new Map<string, Cache>();
  for (const cache of caches) {
    const group = `${cache.ref} ${kind(cache.key)}`;
    const kept = newest.get(group);
    if (!kept || cache.createdAt > kept.createdAt) newest.set(group, cache);
  }
  const kept = new Set(newest.values());
  return caches.filter(
    (cache) => cache.ref.startsWith("refs/tags/") || !kept.has(cache),
  );
}

if (import.meta.main) {
  const caches: Cache[] = JSON.parse(
    execFileSync(
      "gh",
      [
        "cache",
        "list",
        "--limit",
        "1000",
        "--json",
        "id,key,ref,createdAt,sizeInBytes",
      ],
      { encoding: "utf8" },
    ),
  );
  const gone = stale(caches);
  for (const cache of gone) {
    // GitHub may have evicted it meanwhile.
    try {
      execFileSync("gh", ["cache", "delete", String(cache.id)], {
        stdio: "ignore",
      });
    } catch {}
  }
  const kept = caches.filter((cache) => !gone.includes(cache));
  const gb = (bytes: number) => (bytes / 1e9).toFixed(2);
  const show = (title: string, list: Cache[]) => {
    const bytes = list.reduce((sum, cache) => sum + cache.sizeInBytes, 0);
    console.log(`${title} ${list.length}, ${gb(bytes)} GB:`);
    for (const cache of list.sort((a, b) => b.sizeInBytes - a.sizeInBytes))
      console.log(`${gb(cache.sizeInBytes)} GB  ${cache.ref}  ${cache.key}`);
  };
  show("Deleted", gone);
  show("Kept", kept);
}
