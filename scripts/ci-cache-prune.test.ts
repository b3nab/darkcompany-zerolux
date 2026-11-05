import { expect, test } from "bun:test";
import { stale, type Cache } from "./ci-cache-prune";

let id = 0;
const cache = (
  key: string,
  createdAt: string,
  ref = "refs/heads/main",
): Cache => ({
  id: ++id,
  key,
  ref,
  createdAt,
  sizeInBytes: 1,
});

test("only the caches no run restores again go", () => {
  const rust = "v0-rust-Linux-X64-kernel-tests-rust-Linux-x64";
  const replaced = [
    // A Rust build cache after a new lockfile, and after a new toolchain.
    cache(`${rust}-0a1b2c3d-4e5f6a7b`, "2026-11-01T02:00:00Z"),
    cache(`${rust}-0a1b2c3d-8c9d0e1f`, "2026-11-02T02:00:00Z"),
    // The Linux packages of an older runner image.
    cache(
      `apt-kernel-ubuntu24-X64-${"ab".repeat(32)}-20261020.1`,
      "2026-11-01T02:00:00Z",
    ),
    // An older LiveKit server.
    cache("livekit-1.9.3-Linux-X64", "2026-11-01T02:00:00Z"),
  ];
  // What a tag's release saved: no other run reads it.
  const tag = cache(
    `${rust}-12345678-9abcdef0`,
    "2026-11-04T02:00:00Z",
    "refs/tags/v1.0.0",
  );
  const kept = [
    cache(`${rust}-12345678-9abcdef0`, "2026-11-03T02:00:00Z"),
    cache(
      `apt-kernel-ubuntu24-X64-${"cd".repeat(32)}-20261102.1`,
      "2026-11-03T02:00:00Z",
    ),
    cache("livekit-1.9.4-Linux-X64", "2026-11-03T02:00:00Z"),
    // Another system, job or build of the same kind.
    cache(
      "v0-rust-macOS-ARM64-kernel-tests-rust-Darwin-arm64-12345678-9abcdef0",
      "2026-11-01T02:00:00Z",
    ),
    cache(
      "v0-rust-Linux-X64-kernel-lint-lint-Linux-x64-12345678-9abcdef0",
      "2026-11-01T02:00:00Z",
    ),
    cache(
      "v0-rust-Linux-X64-release-x86_64-unknown-linux-gnu-desktop-Linux-x64-12345678-9abcdef0",
      "2026-11-01T02:00:00Z",
    ),
    cache("livekit-1.9.4-macOS-ARM64", "2026-11-01T02:00:00Z"),
    // A branch keeps its own, apart from the default branch's.
    cache(
      `${rust}-0a1b2c3d-4e5f6a7b`,
      "2026-11-01T02:00:00Z",
      "refs/heads/aspen",
    ),
  ];
  const gone = stale([...replaced, tag, ...kept]);
  expect(gone).toEqual([...replaced, tag]);
});
