import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { connect } from "node:net";
import { isAbsolute } from "node:path";

export interface ControlDescriptor extends Record<string, unknown> {
  instance_id: string;
  nonce: string;
  endpoint: string;
  pid: number;
}

export async function readControlDescriptor(
  path: string,
): Promise<ControlDescriptor> {
  if (!isAbsolute(path))
    throw new Error("Native control descriptor must be absolute");
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await file.stat();
    if (
      !stat.isFile() ||
      stat.nlink !== 1 ||
      (stat.mode & 0o077) !== 0 ||
      stat.size > 64 * 1024
    )
      throw new Error(
        "Native control descriptor is not a bounded private regular file",
      );
    const value = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(await file.readFile()),
    ) as ControlDescriptor;
    if (
      !value ||
      typeof value.instance_id !== "string" ||
      !value.instance_id ||
      typeof value.nonce !== "string" ||
      !value.nonce ||
      typeof value.endpoint !== "string" ||
      (!isAbsolute(value.endpoint) &&
        !value.endpoint.startsWith("\\\\.\\pipe\\")) ||
      value.version !== 1 ||
      !Number.isInteger(value.pid) ||
      value.pid <= 0
    )
      throw new Error("Invalid native control descriptor");
    return value;
  } finally {
    await file.close();
  }
}

/** One authenticated local operation. A timeout is uncertainty, never permission to retry input. */
export async function controlRequest(
  descriptor: ControlDescriptor,
  method: string,
  fields: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
  const request =
    JSON.stringify({
      native_session_id: descriptor.native_session_id,
      workspace: descriptor.workspace,
      ...fields,
      method,
      nonce: descriptor.nonce,
    }) + "\n";
  if (Buffer.byteLength(request) > 64 * 1024)
    throw new Error("Native control request is too large");
  return new Promise((resolve, reject) => {
    const socket = connect(descriptor.endpoint);
    const chunks: Buffer[] = [];
    let size = 0,
      done = false;
    const finish = (error?: Error, value?: Record<string, unknown>) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      socket.destroy();
      if (error) reject(error);
      else resolve(value!);
    };
    const timer = setTimeout(
      () =>
        finish(new Error("Native control timed out; no operation was retried")),
      5000,
    );
    socket.once("error", (error) => finish(error));
    socket.once("end", () =>
      finish(new Error("Native control closed without an acknowledgement")),
    );
    socket.once("connect", () => socket.write(request));
    socket.on("data", (data) => {
      const bytes = typeof data === "string" ? Buffer.from(data) : data;
      size += bytes.length;
      if (size > 64 * 1024) {
        finish(new Error("Native control response is too large"));
        return;
      }
      chunks.push(bytes);
      const buffer = Buffer.concat(chunks);
      const end = buffer.indexOf(10);
      if (end < 0) return;
      try {
        const value = JSON.parse(
          new TextDecoder("utf-8", { fatal: true }).decode(
            buffer.subarray(0, end),
          ),
        ) as Record<string, unknown>;
        if (
          !value ||
          value.ok !== true ||
          (method === "describe" &&
            value.instance_id !== descriptor.instance_id)
        )
          throw new Error(
            typeof value?.error === "string"
              ? value.error
              : "Native control identity changed",
          );
        finish(undefined, value);
      } catch (error) {
        finish(
          error instanceof Error
            ? error
            : new Error("Invalid native control response"),
        );
      }
    });
  });
}
