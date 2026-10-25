import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";

export type Channel = "nightly" | "beta" | "stable";
export interface BuildInfo {
  version: string;
  channel: Channel;
  commit: string;
  built_at: string;
  dirty: boolean;
  schema: string;
}

const number = "(?:0|[1-9]\\d*)";
/** The release names we publish; metadata belongs in the build details. */
export const releaseVersion = new RegExp(
  `^(${number}\\.${number}\\.${number})(?:-(alpha\\.\\d{8}\\.[1-9]\\d*|beta\\.[1-9]\\d*|rc\\.[1-9]\\d*))?$`,
);

export function channelOf(version: string): Channel {
  if (version.includes("-alpha.")) return "nightly";
  if (version.includes("-beta.") || version.includes("-rc.")) return "beta";
  if (!version.includes("-")) return "stable";
  throw new Error(`Unknown release stage: ${version}`);
}

export function baseVersion(version: string) {
  const base = version.match(/^(\d+\.\d+\.\d+)(?:[-+]|$)/)?.[1];
  if (!base) throw new Error(`Invalid version: ${version}`);
  return base;
}

export function nextNightly(base: string, date: Date, tags: string[]) {
  const plain = baseVersion(base);
  if (tags.some((tag) => tag.replace(/^v/, "") === plain))
    throw new Error(
      `${plain} is already stable; set the workspace version to the next development version before building a nightly`,
    );
  const day = date.toISOString().slice(0, 10).replaceAll("-", "");
  const prefix = `${plain}-alpha.${day}.`;
  const numbers = tags
    .map((tag) => tag.replace(/^v/, ""))
    .filter((tag) => tag.startsWith(prefix))
    .map((tag) => tag.slice(prefix.length))
    .filter((part) => /^[1-9]\d*$/.test(part))
    .map(Number);
  return `${prefix}${Math.max(0, ...numbers) + 1}`;
}

export function git(root: string, ...args: string[]) {
  try {
    return execFileSync("git", args, {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "";
  }
}

/** Metadata captured by a build, never fetched from the current checkout at app runtime. */
export function buildInfo(
  root: string,
  env = process.env,
  now = new Date(),
): BuildInfo {
  const version = readFileSync(join(root, "Cargo.toml"), "utf8").match(
    /\[workspace\.package\][^[]*?\nversion = "([^"]+)"/,
  )?.[1];
  if (!version) throw new Error("The workspace has no version");
  const commit = env.ZEROLUX_BUILD_COMMIT || git(root, "rev-parse", "HEAD");
  const dirty = !!git(
    root,
    "status",
    "--porcelain",
    "--untracked-files=normal",
  );
  const at = env.ZEROLUX_BUILD_BUILT_AT
    ? new Date(env.ZEROLUX_BUILD_BUILT_AT)
    : now;
  const built_at = at.toISOString().replace(/\.\d{3}Z$/, "Z");
  const stamp = built_at.replaceAll(/[-:]/g, "");
  const local = `${baseVersion(version)}-alpha.${stamp.slice(0, 8)}.0+g${commit.slice(0, 7) || "unknown"}.t${stamp.slice(9, 15)}${dirty ? ".dirty" : ""}`;
  const resolved = env.ZEROLUX_BUILD_VERSION || local;
  const channel = env.ZEROLUX_BUILD_CHANNEL || channelOf(resolved);
  if (!["nightly", "beta", "stable"].includes(channel))
    throw new Error(`Unknown update channel: ${channel}`);
  const hash = createHash("sha256");
  for (const provider of ["sqlite", "postgres"]) {
    hash.update(
      readFileSync(
        join(root, `crates/zerolux/migrations/${provider}/0001_bootstrap.sql`),
      ),
    );
  }
  return {
    version: resolved,
    channel: channel as Channel,
    commit,
    built_at,
    dirty,
    schema: hash.digest("hex"),
  };
}
