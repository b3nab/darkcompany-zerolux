import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentLinkChild } from "./agent-link.ts";

const unixTest = process.platform === "win32" ? test.skip : test;
unixTest(
  "agent-link fixture receives token only on private stdin and exits on EOF",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "zl-link-fixture-"));
    const executable = join(root, "zerolux");
    await writeFile(
      executable,
      `#!/bin/sh
cd "$(dirname "$0")" || exit 1
printf '%s\\n' "$@" > args
IFS= read -r init
printf '%s\\n' "$init" > init
printf '%s\\n' "$init" >&2
printf '{"type":"invalidate"}\\n'
while IFS= read -r line; do :; done
`,
      { mode: 0o700 },
    );
    let invalidations = 0,
      lost = 0;
    const child = new AgentLinkChild(
      () => {
        invalidations++;
      },
      () => {
        lost++;
      },
    );
    try {
      await child.start(executable, "http://127.0.0.1:1234", "FIXTURE_SECRET");
      expect(invalidations).toBe(1);
      expect(await readFile(join(root, "args"), "utf8")).toBe("agent-link\n");
      expect(JSON.parse(await readFile(join(root, "init"), "utf8"))).toEqual({
        base_url: "http://127.0.0.1:1234",
        token: "FIXTURE_SECRET",
      });
      await Promise.all([child.stop(), child.stop()]);
      expect(lost).toBe(0);
    } finally {
      await child.stop();
      await rm(root, { recursive: true, force: true });
    }
  },
);
unixTest(
  "malformed subscriber stdout cannot be treated as a notification or command",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "zl-link-bad-"));
    const executable = join(root, "zerolux");
    await writeFile(
      executable,
      '#!/bin/sh\nprintf \'{"type":"execute","command":"must-not-run"}\\n\'\n',
      { mode: 0o700 },
    );
    let invalidations = 0;
    const child = new AgentLinkChild(
      () => {
        invalidations++;
      },
      () => {},
    );
    try {
      await expect(
        child.start(executable, "http://127.0.0.1:1234", "SECRET"),
      ).rejects.toThrow();
      expect(invalidations).toBe(0);
    } finally {
      await child.stop();
      await rm(root, { recursive: true, force: true });
    }
  },
);
test("subscriber executable must be an absolute ZeroLux binary, not a shell command", async () => {
  const child = new AgentLinkChild(
    () => {},
    () => {},
  );
  await expect(
    child.start("zerolux && touch bad", "http://127.0.0.1", "SECRET"),
  ).rejects.toThrow();
  await expect(
    child.start("/bin/sh", "http://127.0.0.1", "SECRET"),
  ).rejects.toThrow();
  await child.stop();
});
