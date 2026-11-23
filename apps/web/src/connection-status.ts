import { ApiError, Unreachable, request } from "@zerolux/chat";

export type Reachability = "unknown" | "reachable" | "unreachable";

/** A denied or failed workspace read isn't an offline kernel. Probe only on transport failure. */
export async function reachabilityAfter(
  error: unknown,
  kernel: string,
  signal?: AbortSignal,
): Promise<Reachability> {
  if (error instanceof ApiError) return "reachable";
  if (!(error instanceof Unreachable)) return "unknown";
  try {
    await request(kernel, "/health", undefined, signal);
    return "reachable";
  } catch (probe) {
    return probe instanceof ApiError
      ? "reachable"
      : probe instanceof Unreachable
        ? "unreachable"
        : "unknown";
  }
}
export function connectionStatus(
  reach: Reachability,
  live: boolean | undefined,
) {
  if (reach === "unreachable")
    return { tone: "attention", label: "Can't reach kernel" } as const;
  if (live) return { tone: "connected", label: "Live" } as const;
  if (reach === "reachable")
    return {
      tone: "connected",
      label: "Connected",
      detail: live === false ? "Reconnecting live updates" : undefined,
    } as const;
  return { tone: "connecting", label: "Connecting…" } as const;
}
