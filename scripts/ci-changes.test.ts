import { expect, test } from "bun:test";
import { needs } from "./ci-changes";

test("a push runs the jobs that read what it changed", () => {
  // The kernel's code: its Rust jobs and the desktop's, which builds it; no JavaScript reads it.
  expect(needs(["crates/zerolux/src/api.rs"])).toEqual({
    rust: true,
    desktop: true,
    js: false,
  });
  // A runner the kernel's tests start is JavaScript too.
  expect(needs(["harnesses/pi/src/runner.ts"])).toEqual({
    rust: true,
    desktop: true,
    js: true,
  });
  // The web app, the phone and shared packages: only the JavaScript tests.
  expect(
    needs([
      "apps/web/src/Console.tsx",
      "apps/mobile/app/index.tsx",
      "packages/chat/src/chat.ts",
    ]),
  ).toEqual({ rust: false, desktop: false, js: true });
  // The desktop's own code, and the web app's icon it builds its own from.
  expect(needs(["apps/desktop/src-tauri/src/app.rs"])).toEqual({
    rust: false,
    desktop: true,
    js: false,
  });
  expect(needs(["apps/web/index.html"]).desktop).toBe(true);
  // The docs need none: the format check runs on every push.
  expect(needs(["docs/chat.md"])).toEqual({
    rust: false,
    desktop: false,
    js: false,
  });
  // CI itself runs every job.
  expect(needs([".github/workflows/ci.yml"])).toEqual({
    rust: true,
    desktop: true,
    js: true,
  });
});
