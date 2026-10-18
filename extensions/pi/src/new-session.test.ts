import { afterAll, expect, test } from "bun:test";
import { mkdtemp, mkdir, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadPiProfile } from "./execution-profile.ts";
import { openPiSession } from "./new-session.ts";

const agentDir = process.env.PI_CODING_AGENT_DIR;
afterAll(() => {
  if (agentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = agentDir;
});

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "zpi-open-")));
  const agent = join(root, "agent");
  const work = join(root, "work");
  const host = join(root, "host");
  await Promise.all(
    [agent, work, host].map((dir) => mkdir(dir, { mode: 0o700 })),
  );
  await writeFile(join(host, "chat-extension.ts"), "");
  const file = join(root, "saved.jsonl");
  await writeFile(
    file,
    JSON.stringify({ type: "session", version: 3, id: "saved-id", cwd: work }) +
      "\n",
    { mode: 0o600 },
  );
  process.env.PI_CODING_AGENT_DIR = agent;
  return { root, work, host, file, entry: join(host, "runner.ts") };
}

test("a saved session opens with its own identity, file and folder, and the chat extension", async () => {
  const f = await fixture();
  const config = await openPiSession(f.file, f.work, f.entry, "pi");
  expect(config).toMatchObject({
    nativeSessionId: "saved-id",
    file: f.file,
    workspace: f.work,
    pi: "pi",
    opening: true,
  });
  expect(config.creation).toBeUndefined();
  const profile = await loadPiProfile(config.profile, {
    nativeSessionId: "saved-id",
    file: f.file,
    workspace: f.work,
  });
  expect(profile.args).toEqual([
    "--extension",
    join(f.host, "chat-extension.ts"),
  ]);
});

test("a saved session of another folder is not opened", async () => {
  const f = await fixture();
  await expect(openPiSession(f.file, f.root, f.entry, "pi")).rejects.toThrow(
    "does not name this folder",
  );
});
