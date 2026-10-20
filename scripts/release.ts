// A release, ready to publish: one version everywhere, the changelog from the commits, and its
// commit and tag. Pushing the tag publishes it (`git push origin main v<version>`); that is the
// owner's call, never this script's.
import { $ } from "bun";
import { join } from "node:path";

const root = join(import.meta.dir, "..");

/** Where the version is written: the first match of each pattern, its value in group 2. */
export const versioned: [string, RegExp][] = [
  ["Cargo.toml", /(\[workspace\.package\][^[]*?\nversion = ")([^"]+)"/],
  ["apps/desktop/src-tauri/tauri.conf.json", /("version": ")([^"]+)"/],
  ["apps/mobile/package.json", /("version": ")([^"]+)"/],
  ["apps/mobile/app.json", /("version": ")([^"]+)"/],
];

// A pre-release is a number, such as 0.0.1-1: the Windows installer (MSI) takes no other.
export const semver = /^\d+\.\d+\.\d+(-\d+)?$/;

/** The text with its version set, or an error when the file no longer says where it is. */
export function withVersion(file: string, text: string, version: string) {
  const pattern = versioned.find(([path]) => path === file)?.[1];
  if (!pattern?.test(text)) throw new Error(`${file} has no version to set`);
  return text.replace(pattern, `$1${version}"`);
}

if (import.meta.main) {
  const version = process.argv[2]?.replace(/^v/, "") ?? "";
  if (!semver.test(version))
    throw new Error(
      "Usage: bun run release <version>, for example 0.0.1 or 0.0.1-1",
    );
  const tag = `v${version}`;
  $.cwd(root);
  const files = [
    ...versioned.map(([file]) => file),
    "Cargo.lock",
    "CHANGELOG.md",
  ];
  // Other work may go on in the checkout: what a release writes, and the crates' manifests
  // its Cargo.lock follows, hold only what is committed.
  const kept = [
    ...files,
    "crates/zerolux/Cargo.toml",
    "apps/desktop/src-tauri/Cargo.toml",
  ];
  if ((await $`git status --porcelain -- ${kept}`.text()).trim())
    throw new Error(`Commit or put aside the changes to ${kept.join(", ")}`);
  if ((await $`git tag --list ${tag}`.text()).trim())
    throw new Error(`${tag} already exists`);

  for (const [file] of versioned) {
    const path = join(root, file);
    await Bun.write(
      path,
      withVersion(file, await Bun.file(path).text(), version),
    );
  }
  // The workspace's own crates in Cargo.lock, nothing else.
  await $`cargo update --workspace --offline`.quiet();
  await $`bun x --bun git-cliff --tag ${tag} --output CHANGELOG.md`.quiet();

  await $`git add -- ${files}`;
  await $`git commit -q -m ${`chore(release): ${tag}`} -- ${files}`;
  await $`git tag -a ${tag} -m ${`ZeroLux ${version}`}`;
  console.log(`${tag} is ready. Publish it with: git push origin main ${tag}`);
}
