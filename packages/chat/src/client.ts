/** The kernel's HTTP API, for every client: the web app, the desktop and the mobile app. */
export type Harness = "pi" | "claude-code" | "codex";
export const harnessLabels: Record<Harness, string> = {
  pi: "pi",
  "claude-code": "Claude Code",
  codex: "Codex",
};
/** How a Claude Code session ZeroLux runs asks for permission, as the owner chooses it. */
export const claudeModes = {
  default: "Asks you when Claude Code needs your permission",
  acceptEdits: "Edits files without asking",
  plan: "Plans and explains; changes nothing",
  auto: "Claude Code decides on its own",
} as const;
export type ClaudeMode = keyof typeof claudeModes;
export interface Actor {
  id: string;
  name: string;
  kind: "human" | "agent";
  owner_id: string | null;
  harness: Harness | null;
  archived: boolean;
}

let base = "";
/**
 * Where the kernel is. The web app talks to the origin it was loaded from; an app sets
 * the kernel's address (e.g. `http://192.0.2.10:4310`) before anything else. A chat
 * keeps the address it was mounted with: mount it again for another kernel.
 */
export function setKernelUrl(url: string) {
  base = url.replace(/\/+$/, "");
}
export const kernelUrl = () => base;

/** The kernel answered and refused: unlike an unreachable kernel, retrying cannot help. */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}
export const errorMessage = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

/** A call to the current kernel. */
export const api = <T>(path: string, body?: unknown, signal?: AbortSignal) =>
  request<T>(base, path, body, signal);

/** A call to one given kernel, whatever the current one is. */
export async function request<T>(
  kernel: string,
  path: string,
  body?: unknown,
  signal?: AbortSignal,
): Promise<T> {
  // A file goes as it is, with its own type; anything else as JSON.
  const file = body instanceof Blob;
  const response = await fetch(`${kernel.replace(/\/+$/, "")}/api${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers:
      body === undefined
        ? undefined
        : {
            "Content-Type": file
              ? body.type || "application/octet-stream"
              : "application/json",
          },
    body: body === undefined ? undefined : file ? body : JSON.stringify(body),
    signal,
  });
  if (!response.ok) {
    const text = await response.text();
    let message = text || `Request failed (${response.status})`;
    try {
      message = (JSON.parse(text) as { error?: string }).error ?? message;
    } catch {
      /* Plain framework error. */
    }
    throw new ApiError(message, response.status);
  }
  return response.json() as Promise<T>;
}
