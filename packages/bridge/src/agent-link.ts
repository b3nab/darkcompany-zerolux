import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { isAbsolute, basename } from "node:path";

/** Owns only the Rust subscriber process, never the existing pi process. */
export class AgentLinkChild {
  private child?: ChildProcessWithoutNullStreams;
  private closed = false;
  private exit?: Promise<void>;
  private stopping?: Promise<void>;

  constructor(
    private readonly invalidate: () => void,
    private readonly lost: () => void,
  ) {}

  async start(executable: string, base_url: string, token: string) {
    if (this.child || this.closed)
      throw new Error("LiveKit subscriber already started or closed");
    if (
      !isAbsolute(executable) ||
      !["zerolux", "zerolux.exe"].includes(basename(executable))
    )
      throw new Error("Expected the installed ZeroLux executable");
    // Private pairing supplies the known kernel binary; never shell/task data or harness argv.
    const child = spawn(executable, ["agent-link"], {
      stdio: ["pipe", "pipe", "pipe"],
      shell: false,
      // The subscriber needs neither model credentials nor the kernel's LiveKit API secret.
      env: Object.fromEntries(
        [
          "PATH",
          "HOME",
          "USERPROFILE",
          "TMPDIR",
          "TMP",
          "TEMP",
          "SYSTEMROOT",
          "WINDIR",
          "LANG",
          "LC_ALL",
          "SSL_CERT_FILE",
          "SSL_CERT_DIR",
        ].flatMap((name) =>
          process.env[name] === undefined
            ? []
            : [[name, process.env[name]!] as const],
        ),
      ),
    });
    this.child = child;
    this.exit = new Promise<void>((resolve) => {
      child.once("error", () => resolve());
      child.once("exit", () => resolve());
    });
    child.stdin.on("error", () => {});
    // Drain, but never propagate potentially sensitive subprocess diagnostics to UI/chat.
    child.stderr.resume();
    try {
      await new Promise<void>((resolve, reject) => {
        let buffer = "";
        let joined = false;
        const deadline = setTimeout(
          () => reject(new Error("LiveKit subscriber did not join")),
          20_000,
        );
        const fail = () => {
          clearTimeout(deadline);
          if (!joined) reject(new Error("LiveKit subscriber unavailable"));
          if (!this.closed) this.lost();
        };
        child.once("error", fail);
        child.once("exit", fail);
        child.stdout.setEncoding("utf8");
        child.stdout.on("data", (chunk: string) => {
          if (this.closed) return;
          buffer += chunk;
          let end: number;
          while ((end = buffer.indexOf("\n")) >= 0) {
            if (end > 64 * 1024) {
              fail();
              void this.stop();
              return;
            }
            const line = buffer.slice(0, end).replace(/\r$/, "");
            buffer = buffer.slice(end + 1);
            try {
              const record = JSON.parse(line);
              if (record.type !== "invalidate")
                throw new Error("Unexpected subscriber record");
            } catch {
              fail();
              void this.stop();
              return;
            }
            if (!joined) {
              joined = true;
              clearTimeout(deadline);
              resolve();
            }
            this.invalidate();
          }
          if (Buffer.byteLength(buffer) > 64 * 1024) {
            fail();
            void this.stop();
          }
        });
        child.stdin.write(`${JSON.stringify({ base_url, token })}\n`);
      });
    } catch (error) {
      await this.stop();
      throw error;
    }
  }

  stop(): Promise<void> {
    if (this.stopping) return this.stopping;
    this.closed = true;
    this.stopping = this.shutdown();
    return this.stopping;
  }

  private async shutdown() {
    if (!this.child || !this.exit) return;
    this.child.stdin.end();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = (ms: number) =>
      new Promise<"timeout">((resolve) => {
        timer = setTimeout(() => resolve("timeout"), ms);
      });
    if ((await Promise.race([this.exit, deadline(3000)])) === "timeout") {
      this.child.kill("SIGTERM");
      if ((await Promise.race([this.exit, deadline(1000)])) === "timeout")
        this.child.kill("SIGKILL");
    }
    if (timer) clearTimeout(timer);
    await this.exit;
  }
}
