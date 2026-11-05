import { useCallback, useEffect, useState } from "react";
import { errorMessage, kernelUrl, request } from "./client";

// The accounts shown now, each read again when the kernel says one signed in or out.
const shown = new Set<() => void>();

/** The kernel says an account signed in or out, or notices may have been missed: read again. */
export const accountsNotice = () => shown.forEach((reload) => reload());

/**
 * One's harness accounts on a computer: the computer's own on one's own computer; on one open
 * to one, one's own, which the sessions one runs there use. What is connected, never secrets.
 */
export interface HostAccounts {
  claude: {
    /** A guest's `oauth_token` or `api_key`, else as Claude Code says (`claude.ai`…). */
    method: string | null;
    /** Claude Code can work: its sign-in is there. */
    signed_in: boolean;
    email: string | null;
    /** Its plan, as Claude Code names it (`max`). */
    plan: string | null;
    /** A sign-in started from ZeroLux waits for the person. */
    signing_in: boolean;
    /** Why Claude Code could not say. */
    error: string | null;
  };
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
    ? accounts.claude.signed_in || accounts.claude.method !== null
    : harness === "codex"
      ? accounts.codex.signed_in
      : accounts.pi.providers.length > 0;
}

const base = (hostId: string) =>
  `/hosts/${encodeURIComponent(hostId)}/accounts`;

/**
 * One's accounts on the computer the kernel runs on, one's own or one open to one, and the ways
 * to connect them. Each change reads them again, and so does the kernel's word that one signed
 * in or out.
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
  useEffect(() => {
    const again = () => void reload();
    again();
    shown.add(again);
    return () => void shown.delete(again);
  }, [reload]);
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
    /**
     * Claude Code's own sign-in: the address to sign in at. With `browser` the computer's
     * browser opens it too and returns to Claude Code by itself; anywhere else the browser
     * shows a code for `claudeLoginCode`.
     */
    claudeLogin: (browser: boolean) =>
      andReload(
        request<{ url: string }>(kernel, `${base(hostId!)}/claude-code/login`, {
          browser,
        }),
      ),
    /** The code the browser showed, for the sign-in waiting. */
    claudeLoginCode: (code: string) =>
      request(kernel, `${base(hostId!)}/claude-code/login/code`, { code }),
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
