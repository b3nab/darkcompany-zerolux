import { useEffect, useState } from "react";
import { kernelUrl, useHostAccounts } from "@zerolux/chat";
import type { Perform } from "@zerolux/chat";
import { CircleAlertIcon, LogInIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { desktopHere } from "./desktop";

/**
 * Whether this page runs on the kernel's own computer: there Claude Code opens the browser
 * itself, which returns to it on its own; anywhere else the browser shows a code to send.
 */
export function onKernelComputer() {
  if (desktopHere()) return true;
  try {
    const { hostname } = new URL(kernelUrl() || location.origin);
    return ["localhost", "127.0.0.1", "[::1]"].includes(hostname);
  } catch {
    return false;
  }
}

/** One's accounts on a computer, as read once for everything that shows them. */
export type AccountsRead = ReturnType<typeof useHostAccounts>;

/**
 * Claude Code's own sign-in on a computer, from here: Sign in starts it there and gives the
 * page to sign in at; the code that page shows, when it shows one, goes back to Claude Code.
 * While it waits, the same accounts its place shows are read again until Claude Code is
 * signed in, so everything showing them changes together.
 */
export function ClaudeSignIn({
  account,
  busy,
  perform,
}: {
  account: AccountsRead;
  busy: boolean;
  perform: Perform;
}) {
  const { accounts, reload, claudeLogin, claudeLoginCode } = account;
  const [url, setUrl] = useState<string>();
  const [code, setCode] = useState("");
  const [sent, setSent] = useState(false);
  const signedIn = accounts?.claude.signed_in ?? false;
  useEffect(() => {
    if (!url || signedIn) return;
    const timer = setInterval(() => void reload(), 2000);
    return () => clearInterval(timer);
  }, [url, signedIn, reload]);
  useEffect(() => {
    if (signedIn) {
      setUrl(undefined);
      setCode("");
      setSent(false);
    }
  }, [signedIn]);
  if (signedIn) return null;
  if (!url)
    return (
      <Button
        size="sm"
        disabled={busy}
        onClick={() =>
          void perform(async () =>
            setUrl((await claudeLogin(onKernelComputer())).url),
          )
        }
      >
        <LogInIcon />
        Sign in
      </Button>
    );
  return (
    <form
      className="flex w-full flex-col gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        const value = code.trim();
        if (value)
          void perform(async () => {
            await claudeLoginCode(value);
            setSent(true);
          });
      }}
    >
      <p className="text-sm text-muted-foreground">
        Sign in on{" "}
        <a
          href={url}
          target="_blank"
          rel="noreferrer"
          className="text-foreground underline underline-offset-4"
        >
          the Claude sign-in page
        </a>
        {onKernelComputer() ? ", open in your browser" : ""}. If it shows a
        code, paste it here.
      </p>
      <div className="flex items-center gap-2">
        <Input
          aria-label="Sign-in code"
          placeholder="Code"
          autoComplete="off"
          value={code}
          onChange={(event) => {
            setCode(event.target.value);
            setSent(false);
          }}
          className="h-8 min-w-0 flex-1 font-mono text-[12.5px]"
        />
        <Button type="submit" size="sm" disabled={busy || !code.trim()}>
          Send
        </Button>
      </div>
      {sent && (
        <p className="text-xs text-muted-foreground">Checking the code…</p>
      )}
    </form>
  );
}

/**
 * Above a Claude Code session's box when its last turn failed because its sign-in is gone,
 * until Claude Code is signed in again: what happened, and Sign in.
 */
export function ClaudeSignedOut({
  hostId,
  busy,
  perform,
}: {
  hostId: string;
  busy: boolean;
  perform: Perform;
}) {
  const account = useHostAccounts(hostId);
  const signedOut = account.accounts?.claude.signed_in === false;
  // A sign-in made anywhere else, in Accounts, the tray or a terminal, takes it away too.
  const { reload } = account;
  useEffect(() => {
    if (!signedOut) return;
    const timer = setInterval(() => void reload(), 5000);
    return () => clearInterval(timer);
  }, [signedOut, reload]);
  if (!signedOut) return null;
  return (
    <div className="mx-auto flex w-full max-w-3xl flex-wrap items-center justify-between gap-3 rounded-md border border-attention/40 bg-card py-1.5 pr-1.5 pl-3 text-sm">
      <span className="flex items-center gap-2 text-attention">
        <CircleAlertIcon aria-hidden className="size-3.5 shrink-0" />
        Claude Code is signed out
      </span>
      <ClaudeSignIn account={account} busy={busy} perform={perform} />
    </div>
  );
}
