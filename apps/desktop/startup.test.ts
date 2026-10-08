import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("the startup page submits explicit choices and renders refusal as text", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zerolux-desktop-ui-"));
  try {
    const script = join(dir, "fixture.ts");
    await Bun.write(
      script,
      `
      import { strict as assert } from "node:assert";
      class Element extends EventTarget { textContent = ""; value = ""; hidden = true; disabled = true; }
      const elements = Object.fromEntries(["status", "error", "choices", "address", "connection", "local"].map(id => [id, new Element()]));
      const calls = []; let refusal = false;
      globalThis.document = { getElementById: id => elements[id], activeElement: null };
      globalThis.window = { __TAURI_INTERNALS__: { invoke: async (command, args) => {
        calls.push({command, args}); if (refusal) throw "<fixture refusal>";
      } } };
      await import(${JSON.stringify(join(import.meta.dir, "startup.ts"))});
      const state = { status: "Choose", error: null, choosing: true, url: "http://127.0.0.1:4310/" };
      window.zeroluxDesktopState(state);
      assert.equal(elements.choices.hidden, false);
      assert.equal(elements.choices.disabled, false);
      assert.equal(calls.length, 0, "showing the selector must not select a workspace");
      elements.address.value = "  http://127.0.0.1:4311/  ";
      document.activeElement = elements.address;
      window.zeroluxDesktopState(state);
      assert.equal(elements.address.value, "  http://127.0.0.1:4311/  ");
      const submit = new Event("submit", { cancelable: true });
      elements.connection.dispatchEvent(submit);
      await new Promise(resolve => setTimeout(resolve, 0));
      assert.equal(submit.defaultPrevented, true);
      assert.deepEqual(calls[0], { command: "choose_workspace", args: { choice: { mode: "existing", url: "http://127.0.0.1:4311/" } } });
      assert.equal(elements.choices.disabled, true);
      window.zeroluxDesktopState(state);
      refusal = true;
      elements.local.dispatchEvent(new Event("click"));
      await new Promise(resolve => setTimeout(resolve, 0));
      assert.deepEqual(calls[1], { command: "choose_workspace", args: { choice: { mode: "local" } } });
      assert.equal(elements.error.textContent, "<fixture refusal>");
      assert.equal(elements.choices.disabled, false);
      console.log("selector fixture passed");
    `,
    );
    const child = Bun.spawn([process.execPath, script], {
      cwd: dir,
      env: { HOME: dir, TMPDIR: dir, PATH: "/usr/bin:/bin" },
      stdout: "pipe",
      stderr: "pipe",
    });
    const timer = setTimeout(() => child.kill(), 5_000);
    try {
      const [code, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
      expect(stdout).toContain("selector fixture passed");
    } finally {
      clearTimeout(timer);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("only the packaged startup page is granted the host selection command", async () => {
  const config = await Bun.file(
    join(import.meta.dir, "src-tauri/tauri.conf.json"),
  ).json();
  expect(config.app.security.capabilities).toHaveLength(1);
  const capability = config.app.security.capabilities[0];
  expect(capability.local).toBe(true);
  expect(capability.remote).toBeUndefined();
  expect(capability.permissions).toEqual(["allow-choose-workspace"]);
  expect(capability.windows).toEqual(["main"]);
});
