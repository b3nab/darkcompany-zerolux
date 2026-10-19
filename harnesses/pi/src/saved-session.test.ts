import { expect, test } from "bun:test";
import {
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CURRENT_SESSION_VERSION,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import { checkSavedPi, readSavedPi } from "./saved-session.ts";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "zerolux-pi-saved-"));
  const manager = SessionManager.create(root, join(root, "sessions"));
  manager.appendModelChange("fixture", "saved-model");
  manager.appendThinkingLevelChange("high");
  const selected = manager.appendMessage({
    role: "user",
    content: "fixture history",
    timestamp: 1,
  });
  manager.appendModelChange("fixture", "abandoned-model");
  manager.appendThinkingLevelChange("low");
  manager.branch(selected);
  manager.appendMessage({
    role: "user",
    content: "active fixture branch",
    timestamp: 2,
  });
  const file = manager.getSessionFile()!;
  const bytes =
    [manager.getHeader(), ...manager.getEntries()]
      .map((entry) => JSON.stringify(entry))
      .join("\n") + "\n";
  await writeFile(file, bytes, { flag: "wx", mode: 0o600 });
  return {
    root,
    file,
    id: manager.getSessionId(),
    bytes,
    read: () => readSavedPi(file, manager.getSessionId(), root),
    close: () => rm(root, { recursive: true, force: true }),
  };
}

test("preflight uses the native active branch without changing or disclosing history", async () => {
  const f = await fixture();
  try {
    const before = await stat(f.file);
    const value = await f.read();
    expect(value.nativeSessionId).toBe(f.id);
    expect(value.model).toEqual({ provider: "fixture", id: "saved-model" });
    expect(value.thinking).toBe("high");
    expect(JSON.stringify(value)).not.toContain("fixture history");
    expect(JSON.stringify(value)).not.toContain("active fixture branch");
    expect(await readFile(f.file, "utf8")).toBe(f.bytes);
    expect((await stat(f.file)).ino).toBe(before.ino);
    await checkSavedPi(value);
  } finally {
    await f.close();
  }
});

test("missing, empty, malformed, incompatible or misidentified files never become new sessions", async () => {
  const f = await fixture();
  try {
    await expect(
      readSavedPi(join(f.root, "missing.jsonl"), f.id, f.root),
    ).rejects.toThrow();
    expect(
      await stat(join(f.root, "missing.jsonl")).catch(() => null),
    ).toBeNull();
    await expect(readSavedPi(f.file, "wrong-id", f.root)).rejects.toThrow(
      "does not name",
    );
    await expect(readSavedPi(f.file, f.id, tmpdir())).rejects.toThrow(
      "does not name",
    );
    for (const bytes of [
      "",
      "{broken",
      f.bytes.replace(`"version":${CURRENT_SESSION_VERSION}`, '"version":999'),
      f.bytes +
        JSON.stringify({ type: "message", id: "orphan", parentId: "missing" }) +
        "\n",
    ]) {
      await writeFile(f.file, bytes);
      await expect(f.read()).rejects.toThrow();
      expect(await readFile(f.file, "utf8")).toBe(bytes);
    }
    await writeFile(f.file, Buffer.from([0xff]));
    await expect(f.read()).rejects.toThrow();
    expect(await readFile(f.file)).toEqual(Buffer.from([0xff]));
  } finally {
    await f.close();
  }
});

test("no default substitutes a missing model and no changed snapshot can launch", async () => {
  const f = await fixture();
  try {
    const snapshot = await f.read();
    const entries = f.bytes
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    // Keep valid graph identities but remove the model information.
    for (const entry of entries)
      if (entry.type === "model_change") entry.type = "custom";
    await writeFile(
      f.file,
      entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n",
    );
    await expect(f.read()).rejects.toThrow("model is missing");
    await writeFile(f.file, f.bytes + "\n");
    await expect(checkSavedPi(snapshot)).rejects.toThrow(
      "changed before launch",
    );
    const alias = join(f.root, "alias.jsonl");
    await symlink(f.file, alias);
    await expect(readSavedPi(alias, f.id, f.root)).rejects.toThrow();
  } finally {
    await f.close();
  }
});
