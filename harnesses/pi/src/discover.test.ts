import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { SessionInfo } from "@earendil-works/pi-coding-agent";
import { listMetadata, sessionMetadata } from "./discover.ts";

test("metadata projection never copies SDK transcript-derived fields", () => {
  const projected = sessionMetadata({
    id: "native",
    path: "/private/session.jsonl",
    cwd: "/work/project",
    name: "Recognizable",
    created: new Date(1000),
    modified: new Date(2000),
    messageCount: 3,
    firstMessage: "PRIVATE_FIRST",
    allMessagesText: "PRIVATE_HISTORY",
  } as SessionInfo);
  expect(projected.title).toBe("Recognizable");
  expect(projected.last_activity_at).toBe(2000);
  expect(JSON.stringify(projected)).not.toContain("PRIVATE_FIRST");
  expect(JSON.stringify(projected)).not.toContain("PRIVATE_HISTORY");
  expect(projected).not.toHaveProperty("messageCount");
});
test("SDK discovery of deterministic temporary sessions does not launch an AgentSession", async () => {
  const root = await mkdtemp(join(tmpdir(), "zl-session-fixture-"));
  try {
    // A deterministic transcript fixture, consumed only by the OFFICIAL SDK reader.
    const path = join(root, "fixture.jsonl");
    await writeFile(
      path,
      [
        {
          type: "session",
          version: 3,
          id: "native-fixture",
          timestamp: new Date(0).toISOString(),
          cwd: "/work/project",
        },
        {
          type: "message",
          id: "m",
          parentId: null,
          timestamp: new Date(1000).toISOString(),
          message: { role: "user", content: "PRIVATE_PROMPT", timestamp: 1000 },
        },
        {
          type: "session_info",
          id: "name",
          parentId: "m",
          timestamp: new Date(2000).toISOString(),
          name: "Fixture name",
        },
      ]
        .map((line) => JSON.stringify(line))
        .join("\n") + "\n",
    );
    const metadata = await listMetadata(root);
    expect(metadata).toHaveLength(1);
    expect(metadata[0]!.native_session_id).toBe("native-fixture");
    expect(metadata[0]!.title).toBe("Fixture name");
    expect(JSON.stringify(metadata)).not.toContain("PRIVATE_PROMPT");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
