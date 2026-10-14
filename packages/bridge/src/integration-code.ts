import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** Installed integration code, not native configuration, credentials or session files. */
export function integrationRevision(entry: string): string {
  const hash = createHash("sha256");
  const add = (name: string, path: string) => {
    hash.update(name).update("\0").update(readFileSync(path)).update("\0");
  };
  const directory = dirname(entry);
  if (entry.endsWith(".ts") && basename(directory) === "src") {
    const root = dirname(dirname(dirname(directory)));
    const visit = (path: string, prefix: string) => {
      for (const item of readdirSync(path, { withFileTypes: true }).sort(
        (a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0),
      )) {
        if (item.name === "fixtures" || item.name.includes(".test.")) continue;
        const name = `${prefix}/${item.name}`;
        if (item.isDirectory()) visit(join(path, item.name), name);
        else if (item.isFile() && item.name.endsWith(".ts"))
          add(name, join(path, item.name));
      }
    };
    visit(directory, "integration");
    visit(join(root, "packages/bridge/src"), "bridge");
    add("lock", join(root, "bun.lock"));
  } else add("entry", entry);
  return hash.digest("hex");
}

/** Capture at module load; only an authenticated kernel update request checks again. */
export function integrationCode(url: string) {
  const entry = fileURLToPath(url);
  try {
    return {
      revision: integrationRevision(entry),
      current: () => integrationRevision(entry),
    };
  } catch {
    // An unverifiable installation is not permission to close native execution.
    return undefined;
  }
}
export type IntegrationCode = NonNullable<ReturnType<typeof integrationCode>>;
