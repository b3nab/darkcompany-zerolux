import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  rmdir,
  writeFile,
} from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** A live session's identity and state, as its descriptor and `describe` show them. */
export interface Description extends Record<string, unknown> {
  native_session_id: string;
  workspace: string;
}
export interface ControlHost {
  describe(): Description;
  /** One authenticated operation. Never await `close()` here: close waits for this answer. */
  handle(
    method: string,
    request: Record<string, unknown>,
  ): Promise<Record<string, unknown>>;
}

/** The kernel's local control of a session: one JSON line in, with the nonce, one line out. */
export class LocalControl {
  readonly instanceId = randomUUID();
  private nonce = randomBytes(32).toString("hex");
  private server?: Server;
  private directory?: string;
  private descriptor?: string;
  private sockets = new Set<Socket>();
  private replies = new Set<Promise<void>>();
  private closed = false;
  private starting?: Promise<void>;

  constructor(
    private readonly registry: string,
    private readonly host: ControlHost,
    /** Names the process in its socket and errors, e.g. "pi". */
    private readonly label: string,
  ) {}

  async start() {
    if (this.starting || this.closed)
      throw new Error("Control is already started or closed");
    this.starting = this.open();
    try {
      await this.starting;
    } catch (error) {
      await this.close();
      throw error;
    }
  }

  private async open() {
    await mkdir(this.registry, { recursive: true, mode: 0o700 });
    this.directory = await mkdtemp(join(tmpdir(), `zerolux-${this.label}-`));
    const endpoint =
      process.platform === "win32"
        ? `\\\\.\\pipe\\zerolux-${this.label}-${this.instanceId}`
        : join(this.directory, "control.sock");
    const server = createServer((socket) => this.accept(socket));
    this.server = server;
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(endpoint, () => {
          server.removeListener("error", reject);
          resolve();
        });
      });
      this.descriptor = join(this.registry, `${this.instanceId}.json`);
      await writeFile(
        this.descriptor,
        JSON.stringify({
          version: 1,
          instance_id: this.instanceId,
          endpoint,
          nonce: this.nonce,
          pid: process.pid,
          ...this.host.describe(),
        }),
        { flag: "wx", mode: 0o600 },
      );
      server.on("error", () => {
        void this.close();
      });
    } catch (error) {
      throw error;
    }
  }

  private accept(socket: Socket) {
    this.sockets.add(socket);
    socket.on("close", () => this.sockets.delete(socket));
    socket.on("error", () => {});
    socket.setTimeout(65_000, () => socket.destroy());
    socket.setEncoding("utf8");
    let buffer = "";
    let handled = false;
    socket.on("data", (chunk: string) => {
      if (handled || this.closed) {
        socket.destroy();
        return;
      }
      buffer += chunk;
      if (Buffer.byteLength(buffer) > 64 * 1024) {
        socket.destroy();
        return;
      }
      const end = buffer.indexOf("\n");
      if (end < 0) return;
      handled = true;
      if (buffer.slice(end + 1).trim()) {
        socket.destroy();
        return;
      }
      // Answered even if the host ends meanwhile: close waits for this reply.
      const reply = this.handle(buffer.slice(0, end))
        .then(
          (result) => ({ ok: true, ...result }),
          () => ({
            ok: false,
            error: `The ${this.label} link request failed; the session may be busy, changed, or unavailable`,
          }),
        )
        .then(
          (body) =>
            new Promise<void>((resolve) => {
              socket.once("close", resolve);
              socket.end(`${JSON.stringify(body)}\n`, resolve);
            }),
        );
      this.replies.add(reply);
      void reply.finally(() => this.replies.delete(reply));
    });
  }

  private async handle(line: string): Promise<Record<string, unknown>> {
    const request = JSON.parse(line) as Record<string, unknown>;
    const nonce =
      typeof request.nonce === "string"
        ? Buffer.from(request.nonce)
        : Buffer.alloc(0);
    const expected = Buffer.from(this.nonce);
    if (
      this.closed ||
      nonce.length !== expected.length ||
      !timingSafeEqual(nonce, expected)
    )
      throw new Error("Invalid control credential");
    const description = this.host.describe();
    if (request.method === "describe")
      return { instance_id: this.instanceId, ...description };
    // A request naming a session must name this one.
    if (
      ("native_session_id" in request &&
        request.native_session_id !== description.native_session_id) ||
      ("workspace" in request && request.workspace !== description.workspace)
    )
      throw new Error("Native session changed");
    if (typeof request.method !== "string")
      throw new Error("Unknown control operation");
    return this.host.handle(request.method, request);
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    await this.starting?.catch(() => {});
    // No new connections; requests already in progress still get their answer.
    const stopped = this.server
      ? new Promise<void>((resolve) => this.server!.close(() => resolve()))
      : Promise.resolve();
    await Promise.allSettled([...this.replies]);
    for (const socket of this.sockets) socket.destroy();
    await stopped;
    if (this.descriptor) {
      // Do not remove a descriptor replaced by another session/process.
      try {
        const current = JSON.parse(await readFile(this.descriptor, "utf8"));
        if (
          current.instance_id === this.instanceId &&
          current.nonce === this.nonce
        )
          await rm(this.descriptor);
      } catch {
        /* Already removed or replaced. */
      }
    }
    if (this.directory) {
      // Only our mkdtemp directory and native socket, never a caller-provided tree.
      await rm(join(this.directory, "control.sock"), { force: true }).catch(
        () => {},
      );
      await rmdir(this.directory).catch(() => {});
    }
  }
}
