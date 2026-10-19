import { expect, test } from "bun:test";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadPiProfile,
  piResumeArgs,
  savePiProfile,
  type PiExecutionProfile,
} from "./execution-profile.ts";

test("resume keeps native tools/resources/trust but never selectors, initial work or old model overrides", () => {
  expect(
    piResumeArgs([
      "--session",
      "/old.jsonl",
      "--model",
      "old-model",
      "--thinking",
      "low",
      "--mode",
      "json",
      "--print",
      "@private.txt",
      "initial work",
      "--tools",
      "read,bash",
      "--append-system-prompt",
      "private native instructions",
      "--no-approve",
      "--extension",
      "./local.ts",
      "--",
      "--not-an-option",
    ]),
  ).toEqual([
    "--tools",
    "read,bash",
    "--append-system-prompt",
    "private native instructions",
    "--no-approve",
    "--extension",
    "./local.ts",
  ]);
  expect(
    piResumeArgs([
      "--continue",
      "--name",
      "old name",
      "--offline",
      "-nc",
      "-xt",
      "write",
    ]),
  ).toEqual(["--offline", "-nc", "-xt", "write"]);
  expect(() => piResumeArgs(["--api-key", "SECRET"])).toThrow("non-persistent");
  expect(() => piResumeArgs(["--no-session"])).toThrow("no saved history");
  expect(() => piResumeArgs(["--unknown-extension-action", "work"])).toThrow(
    "unsupported",
  );
  expect(() => piResumeArgs(["--tools"])).toThrow("Incomplete");
});

test("private host profile persists atomically, validates identity and refuses substituted initial input", async () => {
  const root = await mkdtemp(join(tmpdir(), "zerolux-pi-profile-"));
  const agentDir = join(root, "agent");
  await mkdir(agentDir);
  const profile: PiExecutionProfile = {
    version: 1,
    nativeSessionId: "fixture",
    file: join(root, "native.jsonl"),
    workspace: root,
    agentDir,
    cliVersion: "0.87.1",
    lastPid: process.pid,
    args: ["--system-prompt", "PRIVATE_NATIVE_PROMPT", "-nt"],
  };
  try {
    const path = await savePiProfile(profile);
    expect((await stat(path)).mode & 0o077).toBe(0);
    expect(await loadPiProfile(path, profile)).toEqual(profile);
    await expect(
      loadPiProfile(path, { ...profile, nativeSessionId: "other" }),
    ).rejects.toThrow("does not match");
    await savePiProfile({
      ...profile,
      unavailable: "Original options cannot be restored",
    });
    await expect(loadPiProfile(path, profile)).rejects.toThrow(
      "cannot be restored",
    );
    await savePiProfile(profile);
    await chmod(path, 0o644);
    await expect(loadPiProfile(path, profile)).rejects.toThrow("private");
    await chmod(path, 0o600);
    await writeFile(
      path,
      JSON.stringify({
        ...profile,
        args: ["--session", "/replacement", "a prompt"],
      }),
    );
    await expect(loadPiProfile(path, profile)).rejects.toThrow("initial work");
    expect(await readFile(path, "utf8")).toContain("/replacement"); // Refusal never repairs data.
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
