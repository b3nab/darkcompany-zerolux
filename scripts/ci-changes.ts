// Which of CI's jobs a push needs, by the files it changed: the Rust workspace's lint and tests,
// the desktop crate's, and the JavaScript and Python tests. The format and type checks always run.
import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";

export interface Needs {
  rust: boolean;
  desktop: boolean;
  js: boolean;
}

/** What the Rust workspace's lint and tests read: its code, and the JavaScript its tests start. */
const rust =
  /^(crates|marketplace|harnesses|services\/auth|packages\/bridge|packages\/extension-sdk|\.cargo|\.config)\/|^(Cargo\.toml|Cargo\.lock|bun\.lock|package\.json)$/;
/** What the desktop crate also builds from: its own folder, and the web app's icon. */
const desktop = /^apps\/desktop\/|^apps\/web\/index\.html$/;
/** What no JavaScript or Python test reads: Rust's own files and the docs. */
const notJs =
  /\.rs$|^(crates|apps\/desktop\/src-tauri|\.cargo|\.config|docs)\/|^Cargo\.(toml|lock)$/;
/** CI itself: every job. */
const ci = /^\.github\/|^scripts\/ci-changes\.ts$/;

export function needs(files: string[]): Needs {
  const all = files.some((file) => ci.test(file));
  const rustNeeded = all || files.some((file) => rust.test(file));
  return {
    rust: rustNeeded,
    desktop: rustNeeded || files.some((file) => desktop.test(file)),
    js: all || files.some((file) => !notJs.test(file)),
  };
}

if (import.meta.main) {
  // `BASE..HEAD`: a push's previous commit or a pull request's base. Without one, as a new
  // branch's first push, or when asked for all of them, as a release does, every job runs.
  const { BASE = "", HEAD = "HEAD", ALL } = process.env;
  let files: string[] | undefined;
  if (ALL !== "true" && BASE && !/^0+$/.test(BASE)) {
    try {
      execFileSync("git", ["fetch", "--no-tags", "--depth=1", "origin", BASE], {
        stdio: "ignore",
      });
      files = execFileSync("git", ["diff", "--name-only", BASE, HEAD], {
        encoding: "utf8",
      })
        .split("\n")
        .filter(Boolean);
    } catch {
      files = undefined;
    }
  }
  const result = files ? needs(files) : { rust: true, desktop: true, js: true };
  const lines = Object.entries(result)
    .map(([job, needed]) => `${job}=${needed}`)
    .join("\n");
  if (process.env.GITHUB_OUTPUT)
    appendFileSync(process.env.GITHUB_OUTPUT, `${lines}\n`);
  console.log(lines);
}
