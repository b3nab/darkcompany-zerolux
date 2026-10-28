// Release builds are immutable; only the signed channel feeds move to a newer release.
import { appendFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import {
  baseVersion,
  buildInfo,
  channelOf,
  git,
  nextNightly,
  releaseVersion,
} from "./build-info";
import type { BuildInfo, Channel } from "./build-info";

const root = join(import.meta.dir, "..");
export const kernelTargets = [
  "aarch64-apple-darwin",
  "x86_64-apple-darwin",
  "x86_64-unknown-linux-gnu",
  "x86_64-pc-windows-msvc",
];
export const desktopTargets = [
  "darwin-aarch64",
  "darwin-x86_64",
  "linux-x86_64",
  "windows-x86_64",
];
type Artifact = { url: string; signature: string };

export function resumeBuild(build: BuildInfo, saved: BuildInfo): BuildInfo {
  if (
    saved.commit !== build.commit ||
    saved.schema !== build.schema ||
    saved.version !== build.version ||
    saved.channel !== build.channel ||
    saved.dirty
  )
    throw new Error("The draft belongs to another source build");
  return saved;
}

/** Stable reaches the testing channels too, without replacing their newer development builds. */
export function advancingChannels(
  build: BuildInfo,
  previous: Partial<Record<Channel, string>>,
): Channel[] {
  const channels: Channel[] =
    build.channel === "stable"
      ? ["stable", "beta", "nightly"]
      : [build.channel];
  return channels.filter((channel) => {
    const version = previous[channel];
    if (!version) return true;
    if (!releaseVersion.test(version))
      throw new Error(`Invalid existing ${channel} feed`);
    return Bun.semver.order(build.version, version) > 0;
  });
}

export function canRestore(version: string, previous?: string) {
  if (
    !releaseVersion.test(version) ||
    (previous && !releaseVersion.test(previous))
  )
    throw new Error("Invalid release feed version");
  return !previous || Bun.semver.order(version, previous) >= 0;
}

export function releaseFeed(
  build: BuildInfo,
  desktop: { version: string; platforms: Record<string, Artifact> },
  kernels: Record<string, Artifact>,
  notes: string,
) {
  if (
    !releaseVersion.test(build.version) ||
    build.dirty ||
    !/^[a-f0-9]{40}$/.test(build.commit)
  )
    throw new Error("A release must identify clean, committed source");
  if (desktop.version.replace(/^v/, "") !== build.version)
    throw new Error("Desktop artifacts have another version");
  for (const [names, artifacts] of [
    [desktopTargets, desktop.platforms],
    [kernelTargets, kernels],
  ] as const) {
    for (const name of names) {
      const artifact = artifacts[name];
      if (!artifact?.signature.trim() || !artifact.url.startsWith("https://"))
        throw new Error(`Missing signed artifact: ${name}`);
      if (!artifact.url.includes(`/v${build.version}/`))
        throw new Error(`Artifact is not immutable: ${name}`);
    }
  }
  return {
    ...build,
    notes: notes.replace(/\s*<!-- zerolux-run:\d+ -->\s*/g, "\n").trim(),
    pub_date: build.built_at,
    platforms: desktop.platforms,
    kernels,
  };
}

if (import.meta.main) {
  const action = process.argv[2];
  if (action === "prepare") {
    const now = new Date();
    const tag =
      process.env.GITHUB_REF_TYPE === "tag"
        ? process.env.GITHUB_REF_NAME
        : undefined;
    const base = buildInfo(root, {}, now);
    const releases = JSON.parse(
      execFileSync(
        "gh",
        [
          "api",
          "--paginate",
          "--slurp",
          `repos/${process.env.GITHUB_REPOSITORY}/releases`,
        ],
        { encoding: "utf8" },
      ),
    ).flat() as {
      tag_name: string;
      draft: boolean;
      body: string | null;
      assets: { name: string }[];
    }[];
    const marker = `<!-- zerolux-run:${process.env.GITHUB_RUN_ID} -->`;
    const existing = tag
      ? releases.find((release) => release.tag_name === tag)
      : releases.find((release) => release.body?.includes(marker));
    if (existing && !existing.draft)
      throw new Error(
        `${existing.tag_name} is already published; its artifacts are immutable`,
      );
    const version =
      (tag || existing?.tag_name)?.replace(/^v/, "") ||
      nextNightly(base.version, now, [
        ...git(root, "tag", "--list", "v*").split("\n"),
        ...releases.map((release) => release.tag_name),
      ]);
    if (!releaseVersion.test(version))
      throw new Error(`Invalid release version: ${version}`);
    let build = {
      ...base,
      version,
      channel: channelOf(version),
      dirty: false,
    };
    if (base.dirty) throw new Error("Build releases from a clean checkout");
    if (existing?.assets.some((asset) => asset.name === "build.json")) {
      const saved = JSON.parse(
        execFileSync(
          "gh",
          [
            "release",
            "download",
            existing.tag_name,
            "--pattern",
            "build.json",
            "--output",
            "-",
          ],
          { encoding: "utf8" },
        ),
      ) as BuildInfo;
      build = resumeBuild(build, saved);
    }
    const dir = process.env.RUNNER_TEMP || "/tmp";
    await Bun.write(
      join(dir, "zerolux-build.json"),
      `${JSON.stringify(build, null, 2)}\n`,
    );
    const outputs = {
      version,
      tag: `v${version}`,
      channel: build.channel,
      commit: build.commit,
      built_at: build.built_at,
      resume: String(!!existing),
    };
    if (process.env.GITHUB_OUTPUT) {
      for (const [key, value] of Object.entries(outputs))
        appendFileSync(process.env.GITHUB_OUTPUT, `${key}=${value}\n`);
    }
    console.log(JSON.stringify(outputs));
  } else if (action === "config") {
    const build = buildInfo(root);
    const pubkey = process.env.ZEROLUX_UPDATE_PUBLIC_KEY;
    if (!pubkey)
      throw new Error("Set ZEROLUX_UPDATE_PUBLIC_KEY for release builds");
    await Bun.write(
      process.argv[3]!,
      JSON.stringify({
        version: build.version,
        bundle: {
          createUpdaterArtifacts: true,
          windows: { wix: { version: baseVersion(build.version) } },
        },
        plugins: { updater: { pubkey, requireSignedVersion: true } },
      }),
    );
  } else if (action === "feed") {
    const dir = process.argv[3]!;
    const build = (await Bun.file(join(dir, "build.json")).json()) as BuildInfo;
    const desktop = (await Bun.file(join(dir, "latest.json")).json()) as {
      version: string;
      platforms: Record<string, Artifact>;
    };
    const tag = `v${build.version}`;
    const release = JSON.parse(
      execFileSync("gh", ["release", "view", tag, "--json", "tagName,assets"], {
        encoding: "utf8",
      }),
    ) as {
      tagName: string;
      assets: { apiUrl: string; url: string }[];
    };
    if (release.tagName !== tag)
      throw new Error("Desktop assets belong to another release");
    const prefix = `https://github.com/${process.env.GITHUB_REPOSITORY}/releases/download/${tag}/`;
    // Tauri Action uses API asset URLs; publish the same assets at their versioned URLs.
    for (const [platform, artifact] of Object.entries(desktop.platforms)) {
      const asset = release.assets.find(
        (asset) => artifact.url === asset.apiUrl || artifact.url === asset.url,
      );
      if (!asset || !asset.url.startsWith(prefix))
        throw new Error(`Desktop artifact is not in this release: ${platform}`);
      artifact.url = asset.url;
    }
    const kernels: Record<string, Artifact> = {};
    for (const target of kernelTargets) {
      const name = `zerolux-v${build.version}-${target}${target.includes("windows") ? ".exe" : ""}`;
      kernels[target] = {
        url: `https://github.com/${process.env.GITHUB_REPOSITORY}/releases/download/v${build.version}/${name}`,
        signature: (await Bun.file(join(dir, `${name}.sig`)).text()).trim(),
      };
    }
    const notes = await Bun.file(join(dir, "notes.md")).text();
    const feed = releaseFeed(build, desktop, kernels, notes);
    await Bun.write(
      join(dir, "release.json"),
      `${JSON.stringify(feed, null, 2)}\n`,
    );
    const previous: Partial<Record<Channel, string>> = {};
    for (const channel of ["nightly", "beta", "stable"] as const) {
      const file = Bun.file(join(dir, "previous", `${channel}.json`));
      if (await file.exists()) previous[channel] = (await file.json()).version;
    }
    const channels = advancingChannels(build, previous);
    for (const channel of channels) {
      await Bun.write(
        join(dir, `${channel}.json`),
        `${JSON.stringify({ ...feed, channel, build_channel: build.channel }, null, 2)}\n`,
      );
    }
    await Bun.write(
      join(dir, "channels"),
      channels.join("\n") + (channels.length ? "\n" : ""),
    );
  } else if (action === "restore") {
    // These files came from the published release and were verified, never rebuilt.
    const dir = process.argv[3]!;
    const release = await Bun.file(join(dir, "release.json")).json();
    const channels: Channel[] = [];
    for (const channel of ["nightly", "beta", "stable"] as const) {
      const file = Bun.file(join(dir, `${channel}.json`));
      if (!(await file.exists())) continue;
      const feed = await file.json();
      if (feed.version !== release.version || feed.channel !== channel)
        throw new Error("The channel feed belongs to another release");
      const previous = Bun.file(join(dir, "previous", `${channel}.json`));
      const version = (await previous.exists())
        ? (await previous.json()).version
        : undefined;
      if (canRestore(feed.version, version)) channels.push(channel);
    }
    await Bun.write(
      join(dir, "channels"),
      channels.join("\n") + (channels.length ? "\n" : ""),
    );
  } else if (action === "verify") {
    const file = process.argv[3]!;
    const pubkey = process.env.ZEROLUX_UPDATE_PUBLIC_KEY;
    if (!pubkey)
      throw new Error("Set ZEROLUX_UPDATE_PUBLIC_KEY to verify the feed");
    await Bun.write(`${file}.pub`, Buffer.from(pubkey, "base64"));
    await Bun.write(
      `${file}.minisig`,
      Buffer.from((await Bun.file(`${file}.sig`).text()).trim(), "base64"),
    );
    execFileSync(
      "minisign",
      ["-Vm", file, "-p", `${file}.pub`, "-x", `${file}.minisig`],
      { stdio: "inherit" },
    );
  } else
    throw new Error(
      "Usage: release-ci.ts prepare | config <path> | feed <folder> | restore <folder> | verify <feed>",
    );
}
