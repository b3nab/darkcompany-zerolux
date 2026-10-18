import { useEffect, useState } from "react";
import { Link } from "react-router";
import {
  accountReady,
  harnessLabels,
  piProviders,
  useHostAccounts,
} from "@zerolux/chat";
import type { DeviceCode, Host, Perform } from "@zerolux/chat";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  NativeSelect,
  NativeSelectOption,
} from "@/components/ui/native-select";

/** A secret as it is typed: hidden, never filled in or kept by the browser. */
function Secret({
  label,
  value,
  set,
}: {
  label: string;
  value: string;
  set: (value: string) => void;
}) {
  return (
    <Input
      type="password"
      autoComplete="off"
      aria-label={label}
      placeholder={label}
      value={value}
      onChange={(event) => set(event.target.value)}
      className="h-8 min-w-0 flex-1 font-mono text-[12.5px]"
    />
  );
}

/** One harness's account: whether it is connected, and how it connects. */
function Account({
  name,
  status,
  children,
}: {
  name: string;
  status: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-2 rounded-md border p-3">
      <p className="flex items-baseline justify-between gap-2 text-sm">
        <span className="font-medium">{name}</span>
        <span className="truncate text-xs text-muted-foreground">{status}</span>
      </p>
      {children}
    </div>
  );
}

/**
 * One's own harness accounts on a computer open to one: the sessions one starts there use
 * them, never its person's. Secrets go to the kernel and never come back.
 */
export function HostAccounts({
  host,
  busy,
  perform,
}: {
  host: Host;
  busy: boolean;
  perform: Perform;
}) {
  const {
    accounts,
    error,
    reload,
    setClaude,
    codexKey,
    codexDeviceCode,
    codexSignOut,
    setPi,
  } = useHostAccounts(host.id);
  const [claude, setClaudeSecret] = useState({
    kind: "api_key" as "api_key" | "oauth_token",
    value: "",
  });
  const [codex, setCodex] = useState("");
  const [code, setCode] = useState<DeviceCode>();
  const [pi, setPiKey] = useState({ provider: piProviders[0]!, key: "" });
  // While a ChatGPT code is shown, Codex finishes on its own: it is read again until it has.
  const signedIn = accounts?.codex.signed_in ?? false;
  useEffect(() => {
    if (!code || signedIn) return;
    const timer = setInterval(() => void reload(), 3000);
    return () => clearInterval(timer);
  }, [code, signedIn, reload]);
  if (!accounts)
    return error ? <p className="text-xs text-destructive">{error}</p> : null;
  return (
    <section
      aria-label="Your accounts here"
      className="flex flex-col gap-2 rounded-lg bg-muted/40 p-3"
    >
      <h3 className="text-sm font-medium">Your accounts here</h3>
      <p className="text-xs text-muted-foreground">
        Sessions you start on {host.name} use these, never its person's. ZeroLux
        keeps them for you on that computer and never shows them again.
      </p>
      <Account
        name="Claude Code"
        status={
          accounts.claude.method === "api_key"
            ? "With an API key"
            : accounts.claude.method === "oauth_token"
              ? "With a subscription token"
              : "Not connected"
        }
      >
        <form
          className="flex flex-wrap items-center gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            const value = claude.value.trim();
            if (value)
              void perform(async () => {
                await setClaude(
                  claude.kind === "api_key"
                    ? { api_key: value }
                    : { oauth_token: value },
                );
                setClaudeSecret({ ...claude, value: "" });
              });
          }}
        >
          <NativeSelect
            size="sm"
            aria-label="Claude Code with"
            value={claude.kind}
            onChange={(event) =>
              setClaudeSecret({
                kind: event.target.value as "api_key" | "oauth_token",
                value: "",
              })
            }
          >
            <NativeSelectOption value="api_key">API key</NativeSelectOption>
            <NativeSelectOption value="oauth_token">
              Subscription token
            </NativeSelectOption>
          </NativeSelect>
          <Secret
            label={
              claude.kind === "api_key"
                ? "Anthropic API key"
                : "Token from claude setup-token"
            }
            value={claude.value}
            set={(value) => setClaudeSecret({ ...claude, value })}
          />
          <Button
            type="submit"
            size="sm"
            disabled={busy || !claude.value.trim()}
          >
            Connect
          </Button>
          {accounts.claude.method && (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={busy}
              onClick={() =>
                void perform(async () => void (await setClaude(null)))
              }
            >
              Remove
            </Button>
          )}
        </form>
        {claude.kind === "oauth_token" && (
          <p className="text-xs text-attention">
            Anthropic's terms limit using claude.ai subscriptions through other
            products; an API key is always within them.
          </p>
        )}
      </Account>
      <Account
        name="Codex"
        status={
          accounts.codex.signed_in
            ? accounts.codex.method === "chatgpt"
              ? `ChatGPT${accounts.codex.email ? ` · ${accounts.codex.email}` : ""}${accounts.codex.plan ? ` · ${accounts.codex.plan}` : ""}`
              : "With an API key"
            : "Not connected"
        }
      >
        {accounts.codex.error && (
          <p className="text-xs text-attention">{accounts.codex.error}</p>
        )}
        {accounts.codex.signed_in ? (
          <Button
            size="sm"
            variant="ghost"
            className="self-start"
            disabled={busy}
            onClick={() =>
              void perform(async () => {
                await codexSignOut();
                setCode(undefined);
              })
            }
          >
            Sign out
          </Button>
        ) : (
          <>
            <form
              className="flex items-center gap-2"
              onSubmit={(event) => {
                event.preventDefault();
                const key = codex.trim();
                if (key)
                  void perform(async () => {
                    await codexKey(key);
                    setCodex("");
                  });
              }}
            >
              <Secret label="OpenAI API key" value={codex} set={setCodex} />
              <Button type="submit" size="sm" disabled={busy || !codex.trim()}>
                Connect
              </Button>
            </form>
            {code ? (
              <p className="text-sm">
                Open{" "}
                <a
                  href={code.verification_url}
                  target="_blank"
                  rel="noreferrer"
                  className="underline underline-offset-4"
                >
                  {code.verification_url}
                </a>{" "}
                and enter{" "}
                <span className="font-mono font-medium">{code.user_code}</span>.
                This page notices when you are in.
              </p>
            ) : (
              <Button
                size="sm"
                variant="outline"
                className="self-start"
                disabled={busy}
                onClick={() =>
                  void perform(async () => setCode(await codexDeviceCode()))
                }
              >
                Sign in with ChatGPT
              </Button>
            )}
          </>
        )}
      </Account>
      <Account
        name="pi"
        status={
          accounts.pi.providers.length
            ? accounts.pi.providers.join(", ")
            : "No provider yet"
        }
      >
        {accounts.pi.providers.map((provider) => (
          <p
            key={provider}
            className="flex items-center justify-between gap-2 text-sm"
          >
            <span className="font-mono text-[12.5px]">{provider}</span>
            <Button
              size="sm"
              variant="ghost"
              disabled={busy}
              onClick={() =>
                void perform(async () => void (await setPi(provider, "")))
              }
            >
              Remove
            </Button>
          </p>
        ))}
        <form
          className="flex flex-wrap items-center gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            const key = pi.key.trim();
            if (key)
              void perform(async () => {
                await setPi(pi.provider, key);
                setPiKey({ ...pi, key: "" });
              });
          }}
        >
          <NativeSelect
            size="sm"
            aria-label="Provider"
            value={pi.provider}
            onChange={(event) =>
              setPiKey({ ...pi, provider: event.target.value })
            }
          >
            {piProviders.map((provider) => (
              <NativeSelectOption key={provider} value={provider}>
                {provider}
              </NativeSelectOption>
            ))}
          </NativeSelect>
          <Secret
            label="Provider API key"
            value={pi.key}
            set={(key) => setPiKey({ ...pi, key })}
          />
          <Button type="submit" size="sm" disabled={busy || !pi.key.trim()}>
            Connect
          </Button>
        </form>
      </Account>
    </section>
  );
}

/** Before a guest's session: the harnesses still without an account of theirs here. */
export function AccountsNeeded({ hostId }: { hostId: string }) {
  const { accounts } = useHostAccounts(hostId);
  if (!accounts) return null;
  const missing = (["claude-code", "codex", "pi"] as const).filter(
    (harness) => !accountReady(accounts, harness),
  );
  if (!missing.length) return null;
  return (
    <p className="rounded-md bg-attention/10 p-3 text-sm">
      Your sessions on this computer use your own accounts.{" "}
      {missing.map((harness) => harnessLabels[harness]).join(", ")}{" "}
      {missing.length === 1 ? "has" : "have"} none yet:{" "}
      <Link to="/settings" className="underline underline-offset-4">
        connect them in Settings
      </Link>
      .
    </p>
  );
}
