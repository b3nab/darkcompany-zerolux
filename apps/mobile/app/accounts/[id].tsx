import * as Clipboard from "expo-clipboard";
import * as Haptics from "expo-haptics";
import { useLocalSearchParams } from "expo-router";
import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { Linking, Pressable, ScrollView, TextInput, View } from "react-native";
import { useCSSVariable } from "uniwind";
import {
  errorMessage,
  piProviders,
  planName,
  useHostAccounts,
} from "@zerolux/chat";
import type { DeviceCode, HostAccounts } from "@zerolux/chat";
import { Screen } from "@/components/screen";
import { Segmented } from "@/components/segmented";
import { Button } from "@/components/ui/button";
import { Text } from "@/components/ui/text";
import { cn } from "@/lib/utils";
import { useSession } from "../../src/kernel";
import { useMe } from "../../src/me";

/**
 * One's harness accounts on the kernel's computer. On one's own, the computer's: whether each
 * is signed in, and Claude Code's and Codex's sign-in. On one open to one, one's own, which the
 * sessions one starts there use, never the computer's. Secrets go in once and never come back.
 */
export default function AccountsPage() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { url, hosts } = useSession();
  const { me } = useMe();
  const host = hosts.hosts?.find((h) => h.id === id);
  const own = !!host && host.person_id === me?.id;
  const accounts = useHostAccounts(id, url);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const act = async (work: () => Promise<unknown>) => {
    setBusy(true);
    setError("");
    try {
      await work();
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      return true;
    } catch (e) {
      setError(errorMessage(e));
      return false;
    } finally {
      setBusy(false);
    }
  };
  const a = accounts.accounts;
  return (
    <Screen
      back
      title={own ? "Accounts" : "Your accounts here"}
      subtitle={host?.name}
    >
      <ScrollView
        contentContainerClassName="gap-6 px-5 py-5"
        keyboardShouldPersistTaps="handled"
      >
        {error || accounts.error ? (
          <Text className="text-sm text-destructive">
            {error || accounts.error}
          </Text>
        ) : null}
        {a ? (
          <>
            <Claude
              claude={a.claude}
              own={own}
              busy={busy}
              save={(secret) => act(() => accounts.setClaude(secret))}
              login={accounts.claudeLogin}
              code={(code) => act(() => accounts.claudeLoginCode(code))}
              failed={(e) => setError(errorMessage(e))}
            />
            <Codex
              codex={a.codex}
              busy={busy}
              key_={(key) => act(() => accounts.codexKey(key))}
              deviceCode={accounts.codexDeviceCode}
              reload={accounts.reload}
              signOut={() => act(() => accounts.codexSignOut())}
              failed={(e) => setError(errorMessage(e))}
            />
            <Pi
              providers={a.pi.providers}
              own={own}
              busy={busy}
              save={(provider, key) => act(() => accounts.setPi(provider, key))}
            />
          </>
        ) : !accounts.error ? (
          <Text className="text-sm text-faint">Reading your accounts…</Text>
        ) : null}
      </ScrollView>
    </Screen>
  );
}

/** A harness's card: its name, whether it is connected, and the ways to connect it. */
function Card({
  title,
  status,
  ready,
  children,
}: {
  title: string;
  status: string;
  ready: boolean;
  children: ReactNode;
}) {
  return (
    <View className="gap-3 rounded-md border border-border bg-card px-4 py-3.5">
      <View className="flex-row items-center gap-2">
        <View
          className={cn(
            "size-2 rounded-full",
            ready ? "bg-success" : "bg-faint",
          )}
        />
        <Text className="flex-1 text-base font-medium">{title}</Text>
      </View>
      <Text className="text-[13px] text-muted-foreground">{status}</Text>
      {children}
    </View>
  );
}

/** A secret typed once: shown as dots, sent with Save, then emptied. */
function SecretField({
  placeholder,
  busy,
  save,
  label = "Save",
}: {
  placeholder: string;
  busy: boolean;
  save: (value: string) => Promise<boolean>;
  label?: string;
}) {
  const faint = String(useCSSVariable("--color-faint"));
  const [value, setValue] = useState("");
  return (
    <View className="flex-row items-center gap-2">
      <TextInput
        value={value}
        onChangeText={setValue}
        secureTextEntry
        // An API key or a token, not a password iOS should offer to save.
        textContentType="oneTimeCode"
        autoCapitalize="none"
        autoCorrect={false}
        placeholder={placeholder}
        placeholderTextColor={faint}
        className="flex-1 rounded-md border border-input bg-background px-3 py-2.5 font-mono text-[14px] text-foreground"
      />
      <Button
        size="sm"
        disabled={busy || !value.trim()}
        onPress={() =>
          void save(value.trim()).then((saved) => saved && setValue(""))
        }
      >
        <Text>{label}</Text>
      </Button>
    </View>
  );
}

/**
 * Claude Code's own sign-in, from the phone: Sign in starts it on the computer and opens the
 * Claude sign-in page here; the code that page shows goes back to Claude Code.
 */
function ClaudeSignIn({
  signedIn,
  busy,
  login,
  code,
  failed,
}: {
  signedIn: boolean;
  busy: boolean;
  login: (browser: boolean) => Promise<{ url: string }>;
  code: (code: string) => Promise<boolean>;
  failed: (e: unknown) => void;
}) {
  // The kernel says when the sign-in ends: the account is read again then.
  const [url, setUrl] = useState<string>();
  if (signedIn) return null;
  if (!url)
    return (
      <Button
        size="sm"
        className="self-start"
        disabled={busy}
        onPress={() =>
          void login(false).then(({ url }) => {
            setUrl(url);
            void Linking.openURL(url);
          }, failed)
        }
      >
        <Text>Sign in</Text>
      </Button>
    );
  return (
    <View className="gap-2">
      <Pressable
        accessibilityRole="link"
        onPress={() => void Linking.openURL(url)}
        className="self-start"
      >
        <Text className="text-[13px] font-medium text-human-foreground">
          Sign-in page
        </Text>
      </Pressable>
      <SecretField placeholder="Code" busy={busy} save={code} label="Send" />
      {busy ? (
        <Text className="text-[13px] text-muted-foreground">
          Checking the code…
        </Text>
      ) : null}
    </View>
  );
}

function Claude({
  claude,
  own,
  busy,
  save,
  login,
  code,
  failed,
}: {
  claude: HostAccounts["claude"];
  own: boolean;
  busy: boolean;
  save: (
    secret: { oauth_token: string } | { api_key: string } | null,
  ) => Promise<boolean>;
  login: (browser: boolean) => Promise<{ url: string }>;
  code: (code: string) => Promise<boolean>;
  failed: (e: unknown) => void;
}) {
  const [kind, setKind] = useState<"api_key" | "oauth_token">("api_key");
  const method = claude.method;
  return (
    <Card
      title="Claude Code"
      ready={claude.signed_in || method !== null}
      status={
        method === "api_key"
          ? "Connected with your API key"
          : method === "oauth_token"
            ? "Connected with your subscription token"
            : claude.signed_in
              ? [
                  "Signed in",
                  claude.email,
                  claude.plan && planName(claude.plan),
                ]
                  .filter(Boolean)
                  .join(" · ")
              : (claude.error ?? "Signed out")
      }
    >
      <ClaudeSignIn
        signedIn={claude.signed_in}
        busy={busy}
        login={login}
        code={code}
        failed={failed}
      />
      {own ? null : (
        <>
          <Segmented<"api_key" | "oauth_token">
            options={[
              ["api_key", "API key"],
              ["oauth_token", "Subscription token"],
            ]}
            value={kind}
            choose={setKind}
          />
          <SecretField
            placeholder={
              kind === "api_key" ? "sk-ant-…" : "From claude setup-token"
            }
            busy={busy}
            save={(value) =>
              save(
                kind === "api_key"
                  ? { api_key: value }
                  : { oauth_token: value },
              )
            }
          />
          {method === "api_key" || method === "oauth_token" ? (
            <Pressable
              accessibilityRole="button"
              disabled={busy}
              onPress={() => void save(null)}
              className="self-start"
            >
              <Text className="text-[13px] font-medium text-destructive">
                Remove
              </Text>
            </Pressable>
          ) : null}
        </>
      )}
    </Card>
  );
}

function Codex({
  codex,
  busy,
  key_,
  deviceCode,
  reload,
  signOut,
  failed,
}: {
  codex: {
    signed_in: boolean;
    method: "chatgpt" | "api_key" | null;
    email: string | null;
    plan: string | null;
    error: string | null;
  };
  busy: boolean;
  key_: (key: string) => Promise<boolean>;
  deviceCode: () => Promise<DeviceCode>;
  reload: () => Promise<unknown>;
  signOut: () => Promise<boolean>;
  failed: (e: unknown) => void;
}) {
  const [code, setCode] = useState<DeviceCode>();
  // While the code waits to be entered elsewhere, the sign-in is read again.
  useEffect(() => {
    if (!code) return;
    if (codex.signed_in) return setCode(undefined);
    const timer = setInterval(() => void reload(), 5000);
    return () => clearInterval(timer);
  }, [code, codex.signed_in, reload]);
  return (
    <Card
      title="Codex"
      ready={codex.signed_in}
      status={
        codex.error
          ? codex.error
          : codex.signed_in
            ? [
                codex.method === "chatgpt"
                  ? "Signed in with ChatGPT"
                  : "Connected with your API key",
                codex.email,
                codex.plan,
              ]
                .filter(Boolean)
                .join(" · ")
            : "Not connected"
      }
    >
      {codex.signed_in ? (
        <Pressable
          accessibilityRole="button"
          disabled={busy}
          onPress={() => void signOut()}
          className="self-start"
        >
          <Text className="text-[13px] font-medium text-destructive">
            Sign out
          </Text>
        </Pressable>
      ) : code ? (
        <View className="gap-2">
          <Text className="text-[13px] text-muted-foreground">
            On another device, open the address and enter this code:
          </Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Copy the code"
            onPress={() => {
              void Clipboard.setStringAsync(code.user_code);
              void Haptics.selectionAsync();
            }}
          >
            <Text className="font-mono text-[22px] tracking-widest">
              {code.user_code}
            </Text>
          </Pressable>
          <Pressable
            accessibilityRole="link"
            onPress={() => void Linking.openURL(code.verification_url)}
          >
            <Text className="text-[13px] text-human-foreground">
              {code.verification_url}
            </Text>
          </Pressable>
          <Text className="text-xs text-faint">Waiting for the sign-in…</Text>
        </View>
      ) : (
        <>
          <Button
            variant="outline"
            disabled={busy}
            onPress={() => void deviceCode().then(setCode, failed)}
          >
            <Text>Sign in with ChatGPT</Text>
          </Button>
          <SecretField placeholder="sk-…" busy={busy} save={key_} />
        </>
      )}
    </Card>
  );
}

function Pi({
  providers,
  own,
  busy,
  save,
}: {
  providers: string[];
  /** The computer's own pi: its keys are kept there, not given here. */
  own: boolean;
  busy: boolean;
  save: (provider: string, key: string) => Promise<boolean>;
}) {
  const [provider, setProvider] = useState(piProviders[0]!);
  return (
    <Card
      title="pi"
      ready={providers.length > 0}
      status={
        providers.length ? `Keys for ${providers.join(", ")}` : "Not connected"
      }
    >
      {own ? null : (
        <>
          {providers.map((name) => (
            <View key={name} className="flex-row items-center justify-between">
              <Text className="font-mono text-[14px]">{name}</Text>
              <Pressable
                accessibilityRole="button"
                disabled={busy}
                onPress={() => void save(name, "")}
              >
                <Text className="text-[13px] font-medium text-destructive">
                  Remove
                </Text>
              </Pressable>
            </View>
          ))}
          <View className="flex-row flex-wrap gap-1.5">
            {piProviders.map((name) => (
              <Pressable
                key={name}
                accessibilityRole="button"
                accessibilityState={{ selected: provider === name }}
                onPress={() => setProvider(name)}
                className={cn(
                  "rounded-full border px-2.5 py-1",
                  provider === name
                    ? "border-human bg-human/10"
                    : "border-border",
                )}
              >
                <Text className="text-xs">{name}</Text>
              </Pressable>
            ))}
          </View>
          <SecretField
            placeholder={`Key for ${provider}`}
            busy={busy}
            save={(key) => save(provider, key)}
          />
        </>
      )}
    </Card>
  );
}
