import { afterAll, expect, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fork } from "./runner.ts";

const configDir = process.env.CLAUDE_CONFIG_DIR;
afterAll(() => {
  if (configDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = configDir;
});

test("a saved Claude Code session forks into a session of its own, whole or up to a message", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "zcl-fork-")));
  const folder = join(root, "work");
  await mkdir(folder);
  process.env.CLAUDE_CONFIG_DIR = join(root, "config");
  const project = join(
    root,
    "config",
    "projects",
    folder.replace(/[^a-zA-Z0-9]/g, "-"),
  );
  await mkdir(project, { recursive: true });
  const session = "3aad9b7c-8834-4fd0-bad4-db1e33573f3d";
  const message = (
    uuid: string,
    parentUuid: string | null,
    role: string,
    text: string,
  ) => ({
    type: role,
    uuid,
    parentUuid,
    sessionId: session,
    cwd: folder,
    timestamp: "2026-10-18T10:00:00.000Z",
    message: { role, content: [{ type: "text", text }] },
  });
  const lines = [
    message(
      "11111111-1111-4111-8111-111111111111",
      null,
      "user",
      "first question",
    ),
    message(
      "22222222-2222-4222-8222-222222222222",
      "11111111-1111-4111-8111-111111111111",
      "assistant",
      "first answer",
    ),
    message(
      "33333333-3333-4333-8333-333333333333",
      "22222222-2222-4222-8222-222222222222",
      "user",
      "second question",
    ),
  ];
  await writeFile(
    join(project, `${session}.jsonl`),
    lines.map((line) => JSON.stringify(line)).join("\n") + "\n",
  );
  const whole = await fork(session, folder);
  expect(whole).not.toBe(session);
  const part = await fork(
    session,
    folder,
    "22222222-2222-4222-8222-222222222222",
  );
  const files = await readdir(project);
  expect(files).toContain(`${whole}.jsonl`);
  const branched = await readFile(join(project, `${part}.jsonl`), "utf8");
  expect(branched).toContain("first answer");
  expect(branched).not.toContain("second question");
});
