import { useCallback, useEffect, useState } from "react";
import { errorMessage, kernelUrl, request } from "./client";

/**
 * One's own harness accounts on a computer open to one: the sessions one runs there use them,
 * never the computer's. What is connected, never the secrets.
 */
export interface HostAccounts {
  claude: { method: "oauth_token" | "api_key" | null };
  codex: {
    signed_in: boolean;
    method: "chatgpt" | "api_key" | null;
    email: string | null;
    plan: string | null;
    /** Why Codex could not say. */
    error: string | null;
  };
  /** The providers pi has a key for. */
  pi: { providers: string[] };
}

/** Signing in to ChatGPT on another device: open the address there and enter the code. */
export interface DeviceCode {
  verification_url: string;
  user_code: string;
}

/** pi's providers people connect most; any other name works too. */
export const piProviders = ["anthropic", "openai", "google", "openrouter"];

/** Whether a harness has an account of one's own on the computer, to start a session with. */
export function accountReady(
  accounts: HostAccounts | undefined,
  harness: "claude-code" | "codex" | "pi",
) {
  if (!accounts) return false;
  return harness === "claude-code"
    ? accounts.claude.method !== null
    : harness === "codex"
      ? accounts.codex.signed_in
      : accounts.pi.providers.length > 0;
}

const base = (hostId: string) =>
  `/hosts/${encodeURIComponent(hostId)}/accounts`;

/**
 * One's own accounts on a computer open to one, and the ways to connect them. Each change reads
 * them again. Only for a guest on the computer the kernel runs on.
 */
export function useHostAccounts(
  hostId: string | undefined,
  kernel = kernelUrl(),
) {
  const [read, setRead] = useState<{
    host: string;
    accounts?: HostAccounts;
    error?: string;
  }>();
  const host = `${kernel}\n${hostId}`;
  const reload = useCallback(
    async () =>
      hostId === undefined
        ? undefined
        : request<{ accounts: HostAccounts }>(kernel, base(hostId)).then(
            ({ accounts }) => setRead({ host, accounts }),
            (error: unknown) =>
              setRead((was) => ({
                ...(was?.host === host ? was : { host }),
                error: errorMessage(error),
              })),
          ),
    [kernel, hostId, host],
  );
  useEffect(() => void reload(), [reload]);
  const current = read?.host === host ? read : undefined;
  const andReload = <T>(work: Promise<T>) =>
    work.then(async (value) => {
      await reload();
      return value;
    });
  return {
    accounts: current?.accounts,
    error: current?.error ?? "",
    reload,
    /** Claude Code with a token from `claude setup-token`, or an API key; nothing removes it. */
    setClaude: (secret: { oauth_token: string } | { api_key: string } | null) =>
      andReload(
        request(
          kernel,
          `${base(hostId!)}/claude-code`,
          secret ?? {},
          undefined,
          "PUT",
        ),
      ),
    /** Codex with an API key. */
    codexKey: (api_key: string) =>
      andReload(request(kernel, `${base(hostId!)}/codex`, { api_key })),
    /** Codex with ChatGPT: the code to enter on another device; Codex then finishes alone. */
    codexDeviceCode: () =>
      request<DeviceCode>(kernel, `${base(hostId!)}/codex`, {
        device_code: true,
      }),
    codexSignOut: () =>
      andReload(
        request(
          kernel,
          `${base(hostId!)}/codex`,
          undefined,
          undefined,
          "DELETE",
        ),
      ),
    /** pi's key for a provider; an empty key removes it. */
    setPi: (provider: string, api_key: string) =>
      andReload(
        request(
          kernel,
          `${base(hostId!)}/pi`,
          { provider, api_key },
          undefined,
          "PUT",
        ),
      ),
  };
}
