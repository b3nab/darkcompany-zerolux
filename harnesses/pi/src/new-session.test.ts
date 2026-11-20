import { afterAll, expect, test } from "bun:test";
import {
  mkdtemp,
  mkdir,
  readFile,
  realpath,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chatExtension, forkPiSession, newPiSession } from "./new-session.ts";

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

test("a new session gets pi's own identity and file, in its folder, to start pi on", async () => {
  const f = await fixture();
  const config = await newPiSession(f.work, f.entry, "pi", { effort: "low" });
  expect(config).toMatchObject({
    workspace: f.work,
    pi: "pi",
    creation: true,
    initial: { effort: "low" },
  });
  const header = JSON.parse(
    (await readFile(config.file, "utf8")).split("\n")[0]!,
  );
  expect(header).toMatchObject({
    type: "session",
    id: config.nativeSessionId,
    cwd: f.work,
  });
  // The host starts it with ZeroLux's extension, found beside itself.
  expect(await chatExtension(f.entry)).toBe(join(f.host, "chat-extension.ts"));
});

test("a saved session forks whole, or up to one of its entries, into a session of its own", async () => {
  const f = await fixture();
  const entry = (id: string, parentId: string | null, text: string) => ({
    type: "message",
    id,
    parentId,
    timestamp: "2026-10-18T10:00:00.000Z",
    message: { role: "user", content: [{ type: "text", text }], timestamp: 0 },
  });
  await writeFile(
    f.file,
    [
      {
        type: "session",
        version: 3,
        id: "saved-id",
        cwd: f.work,
        timestamp: "2026-10-18T10:00:00.000Z",
      },
      entry("a1", null, "first"),
      entry("a2", "a1", "second"),
    ]
      .map((line) => JSON.stringify(line))
      .join("\n") + "\n",
  );
  const whole = await forkPiSession(f.file, f.work);
  expect(whole.native_session_id).not.toBe("saved-id");
  const copied = await Bun.file(whole.file).text();
  expect(copied).toContain("second");
  const part = await forkPiSession(f.file, f.work, "a1");
  const branched = await Bun.file(part.file).text();
  expect(branched).toContain("first");
  expect(branched).not.toContain("second");
});
