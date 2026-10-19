import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

async function gate() {
  const root = await mkdtemp(join(tmpdir(), "zerolux-pi-exec-"));
  const child = Bun.spawn(
    [process.execPath, join(import.meta.dir, "exec-gate.ts")],
    {
      env: { HOME: root, PATH: "/usr/bin:/bin", TMPDIR: root },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  return {
    root,
    child,
    async close() {
      child.kill();
      await child.exited;
      await rm(root, { recursive: true, force: true });
    },
  };
}

test("the recorded gate PID becomes the native PID without swallowing queued RPC input", async () => {
  const f = await gate();
  try {
    await Bun.sleep(30);
    expect(f.child.exitCode).toBeNull();
    const script =
      'let s="";process.stdin.on("data",b=>{s+=b;if(s.includes("\\n")){console.log(JSON.stringify({pid:process.pid,input:s.trim()}));process.exit(0)}})';
    f.child.stdin.write(
      JSON.stringify({ exec: process.execPath, args: ["-e", script] }) +
        '\n{"type":"get_state"}\n',
    );
    await f.child.stdin.flush();
    const response = await new Response(f.child.stdout).json();
    expect(response.pid).toBe(f.child.pid);
    expect(response.input).toBe('{"type":"get_state"}');
    expect(await f.child.exited).toBe(0);
  } finally {
    await f.close();
  }
}, 5000);

test("EOF before authorization exits without executing any native command", async () => {
  const f = await gate();
  try {
    f.child.stdin.end();
    expect(await f.child.exited).toBe(0);
    expect(await new Response(f.child.stdout).text()).toBe("");
  } finally {
    await f.close();
  }
});
