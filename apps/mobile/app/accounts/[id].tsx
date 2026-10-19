import * as Clipboard from "expo-clipboard";
import * as Haptics from "expo-haptics";
import { useLocalSearchParams } from "expo-router";
import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { Linking, Pressable, ScrollView, TextInput, View } from "react-native";
import { useCSSVariable } from "uniwind";
import { errorMessage, piProviders, useHostAccounts } from "@zerolux/chat";
import type { DeviceCode } from "@zerolux/chat";
import { Screen } from "@/components/screen";
import { Segmented } from "@/components/segmented";
import { Button } from "@/components/ui/button";
import { Text } from "@/components/ui/text";
import { cn } from "@/lib/utils";
import { useSession } from "../../src/kernel";

/**
 * One's own harness accounts on a computer open to one: the sessions one starts there use
 * them, never the computer's own. Secrets go in once and never come back.
 */
export default function AccountsPage() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { url, hosts } = useSession();
  const host = hosts.hosts?.find((h) => h.id === id);
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
    <Screen back title="Your accounts here" subtitle={host?.name}>
      <ScrollView
        contentContainerClassName="gap-6 px-5 py-5"
        keyboardShouldPersistTaps="handled"
      >
        <Text className="text-[15px] leading-[22px] text-muted-foreground">
          The sessions you start on this computer run with these accounts, with
          their own settings and history, never with the computer's.
        </Text>
        {error || accounts.error ? (
          <Text className="text-sm text-destructive">
            {error || accounts.error}
          </Text>
        ) : null}
        {a ? (
          <>
            <Claude
              method={a.claude.method}
              busy={busy}
              save={(secret) => act(() => accounts.setClaude(secret))}
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

function Claude({
  method,
  busy,
  save,
}: {
  method: "oauth_token" | "api_key" | null;
  busy: boolean;
  save: (
    secret: { oauth_token: string } | { api_key: string } | null,
  ) => Promise<boolean>;
}) {
  const [kind, setKind] = useState<"api_key" | "oauth_token">("api_key");
  return (
    <Card
      title="Claude Code"
      ready={method !== null}
      status={
        method === "api_key"
          ? "Connected with your API key."
          : method === "oauth_token"
            ? "Connected with your subscription token."
            : "Not connected: an API key, or a subscription token."
      }
    >
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
          save(kind === "api_key" ? { api_key: value } : { oauth_token: value })
        }
      />
      {kind === "oauth_token" ? (
        <Text className="text-xs text-attention">
          Anthropic's terms limit using claude.ai subscriptions through other
          products; an API key is always within them.
        </Text>
      ) : null}
      {method !== null ? (
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
            : "Not connected: sign in with ChatGPT, or an API key."
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
          <Text className="text-xs text-faint">
            Waiting for the sign-in… ChatGPT asks to allow device codes in its
            security settings.
          </Text>
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
  busy,
  save,
}: {
  providers: string[];
  busy: boolean;
  save: (provider: string, key: string) => Promise<boolean>;
}) {
  const [provider, setProvider] = useState(piProviders[0]!);
  return (
    <Card
      title="pi"
      ready={providers.length > 0}
      status={
        providers.length
          ? `Keys for ${providers.join(", ")}.`
          : "Not connected: a key for one of its providers."
      }
    >
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
              provider === name ? "border-human bg-human/10" : "border-border",
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
    </Card>
  );
}
