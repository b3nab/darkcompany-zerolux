import { expect, test } from "bun:test";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalControl } from "./local-control.ts";
import { controlRequest, readControlDescriptor } from "./control-client.ts";

test("private control authenticates the instance and scopes mutations to the native identity", async () => {
  const root = await mkdtemp(join(tmpdir(), "zerolux-control-client-"));
  let calls = 0;
  const control = new LocalControl(
    root,
    {
      describe: () => ({ native_session_id: "native", workspace: root }),
      async handle(method) {
        calls++;
        return { result: method };
      },
    },
    "fixture",
  );
  try {
    await control.start();
    const path = join(root, `${control.instanceId}.json`);
    const descriptor = await readControlDescriptor(path);
    expect((await controlRequest(descriptor, "describe")).instance_id).toBe(
      control.instanceId,
    );
    expect((await controlRequest(descriptor, "fixture")).result).toBe(
      "fixture",
    );
    await expect(
      controlRequest({ ...descriptor, nonce: "wrong" }, "fixture"),
    ).rejects.toThrow();
    await expect(
      controlRequest(descriptor, "fixture", { native_session_id: "another" }),
    ).rejects.toThrow();
    await expect(
      controlRequest({ ...descriptor, instance_id: "another" }, "describe"),
    ).rejects.toThrow("identity changed");
    expect(calls).toBe(1);
    await chmod(path, 0o644);
    await expect(readControlDescriptor(path)).rejects.toThrow("private");
  } finally {
    await control.close();
    await rm(root, { recursive: true, force: true });
  }
});
