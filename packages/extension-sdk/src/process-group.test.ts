import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { join } from "node:path";

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

test.skipIf(process.platform === "win32")(
  "what an extension started ends when its input closes",
  async () => {
    const sdk = join(import.meta.dir, "index.ts");
    const program = `
      import { spawn } from "node:child_process";
      import { serve } from ${JSON.stringify(sdk)};
      const child = spawn("sleep", ["600"], { stdio: "ignore" });
      process.stdout.write(child.pid + "\\n");
      await serve({ id: "test" } as never, Bun.stdin.stream(), () => {});
    `;
    const extension = spawn(process.execPath, ["-e", program], {
      // The kernel makes the extension the leader of a process group of its own.
      detached: true,
      stdio: ["pipe", "pipe", "inherit"],
      env: { ...process.env, ZEROLUX_PROCESS_GROUP: "1" },
    });
    const started = await new Promise<number>((resolve) =>
      extension.stdout!.once("data", (data) => resolve(Number(String(data)))),
    );
    try {
      expect(alive(started)).toBe(true);
      // The kernel ended: the extension's input closes.
      extension.stdin!.end();
      for (let i = 0; i < 100 && alive(started); i++) await Bun.sleep(20);
      expect(alive(started)).toBe(false);
    } finally {
      if (alive(started)) process.kill(started, "SIGKILL");
      extension.kill("SIGKILL");
    }
  },
);
