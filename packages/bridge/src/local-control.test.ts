import { expect, test } from "bun:test";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalControl } from "./local-control.ts";

const rpc = (endpoint: string, body: unknown) =>
  new Promise<unknown>((resolve, reject) => {
    const socket = connect(endpoint);
    let data = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => (data += chunk));
    socket.on("end", () => resolve(data ? JSON.parse(data) : undefined));
    socket.on("error", reject);
    socket.write(`${JSON.stringify(body)}\n`);
  });

test("a request in progress is still answered when the control closes meanwhile", async () => {
  const root = await mkdtemp(join(tmpdir(), "zerolux-control-"));
  let closing: Promise<void> | undefined;
  try {
    const control: LocalControl = new LocalControl(
      root,
      {
        describe: () => ({ native_session_id: "native", workspace: root }),
        handle: async (method) => {
          // As a runner's Stop: the session ends, and the process closes its control at once.
          closing = control.close();
          await Bun.sleep(20);
          return { done: method };
        },
      },
      "test",
    );
    await control.start();
    const name = (await readdir(root)).find((f) => f.endsWith(".json"))!;
    const { endpoint, nonce } = JSON.parse(
      await readFile(join(root, name), "utf8"),
    );
    expect(await rpc(endpoint, { nonce, method: "stop" })).toEqual({
      ok: true,
      done: "stop",
    });
    await closing;
    // Closed: no descriptor left.
    expect((await readdir(root)).filter((f) => f.endsWith(".json"))).toEqual(
      [],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
