import { expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildInfo, channelOf, nextNightly } from "./build-info";
import {
  advancingChannels,
  canRestore,
  desktopTargets,
  kernelTargets,
  releaseFeed,
  resumeBuild,
} from "./release-ci";

test("nightly numbering is per UTC day and version, and skips failed reserved tags", () => {
  const date = new Date("2026-10-24T00:05:00+02:00");
  expect(
    nextNightly("0.0.1-dev", date, [
      "v0.0.1-alpha.20261023.1",
      "v0.0.1-alpha.20261023.3",
      "v0.0.1-alpha.20261022.9",
      "v0.0.2-alpha.20261023.10",
    ]),
  ).toBe("0.0.1-alpha.20261023.4");
});

test("a released stable version requires the next development base", () => {
  const day = new Date("2026-10-23T12:00:00Z");
  expect(() => nextNightly("0.0.1", day, ["v0.0.1"])).toThrow();
  expect(nextNightly("0.0.2-dev", day, ["v0.0.1"])).toBe(
    "0.0.2-alpha.20261023.1",
  );
});

test("beta and release candidates share a channel, with SemVer promotion in order", () => {
  const stages = [
    "0.0.1-alpha.20261023.1",
    "0.0.1-beta.1",
    "0.0.1-rc.1",
    "0.0.1",
  ];
  expect(stages.map(channelOf)).toEqual(["nightly", "beta", "beta", "stable"]);
  for (let i = 1; i < stages.length; i++)
    expect(
      Bun.semver.satisfies(stages[i]!, `>${stages[i - 1]}`, {
        includePrerelease: true,
      }),
    ).toBe(true);
});

test("a channel feed requires every signed immutable artifact from the same release", () => {
  const build = {
    version: "0.0.1-beta.1",
    channel: "beta" as const,
    commit: "a".repeat(40),
    built_at: "2026-10-23T12:00:00Z",
    dirty: false,
    schema: "b".repeat(64),
  };
  const artifact = {
    url: "https://github.com/aspen/notes/releases/download/v0.0.1-beta.1/app",
    signature: "signed",
  };
  const platforms = Object.fromEntries(
    desktopTargets.map((target) => [target, artifact]),
  );
  const kernels = Object.fromEntries(
    kernelTargets.map((target) => [target, artifact]),
  );
  expect(
    releaseFeed(
      build,
      { version: build.version, platforms },
      kernels,
      "Changes",
    ).channel,
  ).toBe("beta");
  expect(
    releaseFeed(
      build,
      { version: build.version, platforms },
      kernels,
      "Changes\n\n<!-- zerolux-run:12345 -->\n",
    ).notes,
  ).toBe("Changes");
  expect(() =>
    releaseFeed(build, { version: "0.0.1-beta.2", platforms }, kernels, ""),
  ).toThrow();
  expect(() =>
    releaseFeed(build, { version: build.version, platforms }, {}, ""),
  ).toThrow();
  expect(() =>
    releaseFeed(
      { ...build, dirty: true },
      { version: build.version, platforms },
      kernels,
      "",
    ),
  ).toThrow();
});

test("stable promotes testing channels without rolling any channel backward", () => {
  const build = {
    version: "0.0.1",
    channel: "stable" as const,
    commit: "a".repeat(40),
    built_at: "2026-10-23T12:00:00Z",
    dirty: false,
    schema: "b".repeat(64),
  };
  expect(
    advancingChannels(build, {
      beta: "0.0.1-rc.2",
      nightly: "0.0.2-alpha.20261023.1",
    }),
  ).toEqual(["stable", "beta"]);
  expect(
    advancingChannels(build, {
      stable: "0.0.2",
      beta: "0.0.2-beta.1",
      nightly: "0.0.2-alpha.20261023.1",
    }),
  ).toEqual([]);
});

test("a publication retry repairs an equal pointer but cannot roll back a newer one", () => {
  expect(canRestore("0.0.1-rc.2", "0.0.1-rc.2")).toBe(true);
  expect(canRestore("0.0.1-rc.2", "0.0.1-rc.1")).toBe(true);
  expect(canRestore("0.0.1-rc.2", "0.0.1")).toBe(false);
});

test("resuming a draft preserves its compiled date and rejects another commit or schema", () => {
  const build = {
    version: "0.0.1-beta.1",
    channel: "beta" as const,
    commit: "a".repeat(40),
    built_at: "2026-10-23T12:00:00Z",
    dirty: false,
    schema: "b".repeat(64),
  };
  const saved = { ...build, built_at: "2026-10-22T12:00:00Z" };
  expect(resumeBuild(build, saved)).toEqual(saved);
  expect(() =>
    resumeBuild(build, { ...saved, commit: "c".repeat(40) }),
  ).toThrow();
  expect(() =>
    resumeBuild(build, { ...saved, schema: "c".repeat(64) }),
  ).toThrow();
});

test("checkout metadata reserves zero and does not rewrite source manifests", async () => {
  const root = await mkdtemp(join(tmpdir(), "zerolux-build-"));
  try {
    const manifest = '[workspace.package]\nversion = "0.0.1-dev"\n';
    await writeFile(join(root, "Cargo.toml"), manifest);
    for (const provider of ["sqlite", "postgres"]) {
      const dir = join(root, "crates/zerolux/migrations", provider);
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, "0001_bootstrap.sql"), provider);
    }
    const build = buildInfo(root, {}, new Date("2026-10-23T12:30:00Z"));
    expect(build.version).toBe("0.0.1-alpha.20261023.0+gunknown.t123000");
    expect(build.channel).toBe("nightly");
    expect(build.schema).toMatch(/^[a-f0-9]{64}$/);
    expect(await Bun.file(join(root, "Cargo.toml")).text()).toBe(manifest);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
