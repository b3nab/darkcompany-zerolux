/**
 * The local marketplace, for development: each extension in `marketplace/`, built for this
 * computer, packed and signed with a development key kept in the data folder, and listed in
 * `marketplace/index.json` there, which a kernel run from this checkout reads. It never reaches
 * a marketplace in production. Run it again after changing an extension; raise its version to see
 * it offered as an update.
 *
 *   bun run marketplace [--data-dir .zerolux]
 */
import { existsSync } from "node:fs";
import {
  chmod,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const flag = process.argv.indexOf("--data-dir");
const dataDir = resolve(root, flag >= 0 ? process.argv[flag + 1]! : ".zerolux");
const out = join(dataDir, "marketplace");
const packages = join(out, "packages");
const key = join(out, "zerolux.key.json");

/** This computer, as kernel modules are named for it. */
const platform = `${
  { darwin: "macos", win32: "windows" }[process.platform as string] ??
  process.platform
}-${{ arm64: "aarch64", x64: "x86_64" }[process.arch as string] ?? process.arch}`;

async function zerolux(...args: string[]) {
  const run = Bun.spawn(
    ["cargo", "run", "-q", "-p", "zerolux", "--", ...args],
    {
      cwd: root,
      stdout: "pipe",
      stderr: "inherit",
    },
  );
  const text = await new Response(run.stdout).text();
  if ((await run.exited) !== 0)
    throw new Error(`zerolux ${args.join(" ")} failed`);
  return text.trim();
}

// Its folder keeps the development key: private to this system user, as a key's folder must be.
await mkdir(out, { recursive: true, mode: 0o700 });
await chmod(out, 0o700);
if (!existsSync(key)) await zerolux("ext", "key", "zerolux", "--out", key);
const publicKey = JSON.parse(await readFile(key, "utf8")).public as string;

/** The few manifest fields the index lists. */
function field(manifest: string, name: string) {
  return (
    manifest.match(new RegExp(`^${name}\\s*=\\s*"([^"]*)"`, "m"))?.[1] ?? ""
  );
}

await rm(packages, { recursive: true, force: true });
await mkdir(packages, { recursive: true });
const extensions = [];
for (const entry of await readdir(join(root, "marketplace"), {
  withFileTypes: true,
})) {
  const folder = join(root, "marketplace", entry.name);
  const manifestPath = join(folder, "zerolux-extension.toml");
  if (!entry.isDirectory() || !existsSync(manifestPath)) continue;
  const manifest = await readFile(manifestPath, "utf8");
  const kernel = /^\[kernel\]/m.test(manifest);
  if (kernel || existsSync(join(folder, "ui/src")))
    await zerolux("ext", "build", folder);
  const packed = (
    await zerolux("ext", "pack", folder, "--key", key, "--out", packages)
  ).split("\n")[0]!;
  const sha256 = new Bun.CryptoHasher("sha256")
    .update(await readFile(packed))
    .digest("hex");
  const id = field(manifest, "id");
  const version = field(manifest, "version");
  // A kernel module is built for this computer only; anything else runs anywhere.
  const target = kernel ? platform : "any";
  const file = `${id}-${version}-${target}.zlx`;
  await rename(packed, join(packages, file));
  const parts = [
    ...(kernel ? ["kernel"] : []),
    ...(/^\[process\]/m.test(manifest) ? ["process"] : []),
    ...(existsSync(join(folder, "ui/native")) ? ["interface"] : []),
  ];
  extensions.push({
    id,
    name: field(manifest, "name"),
    description: field(manifest, "description"),
    publisher: field(manifest, "publisher"),
    versions: [
      {
        version,
        kernel: field(manifest, "kernel") || undefined,
        parts,
        packages: { [target]: { url: `packages/${file}`, sha256 } },
      },
    ],
  });
  console.log(`${id} ${version} (${parts.join(", ")})`);
}
await writeFile(
  join(out, "index.json"),
  JSON.stringify(
    {
      name: "Local marketplace",
      publishers: { zerolux: { key: publicKey } },
      extensions,
    },
    null,
    2,
  ),
);
console.log(join(out, "index.json"));
