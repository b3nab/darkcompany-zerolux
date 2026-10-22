import { ChevronRightIcon } from "lucide-react-native";
import type { ReactNode } from "react";
import { useState } from "react";
import { Image, Pressable, Switch, View } from "react-native";
import { useCSSVariable } from "uniwind";
import {
  authorColor,
  cardFileUrl,
  cardIcon,
  errorMessage,
  extensionCategories,
  extensionsNotice,
  offerVersions,
  proposer,
  setExtensionSettings,
} from "@zerolux/chat";
import type {
  Extension,
  ExtensionCard,
  ExtensionSetting,
  MarketplaceOffer,
} from "@zerolux/chat";
import { Choice } from "@/components/choice";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Text } from "@/components/ui/text";
import { cn } from "@/lib/utils";
import { useSession } from "../src/kernel";
import { useTheme } from "../src/theme";

/** How an extension stands: running, enabled but stopped, off, or failed with its reason. */
export function extensionState(extension: Extension) {
  if (extension.error) return { label: "Error", tone: "error" as const };
  if (!extension.enabled) return { label: "Disabled", tone: "off" as const };
  return extension.running
    ? { label: "Running", tone: "on" as const }
    : { label: "Enabled", tone: "off" as const };
}

/** Who proposed an extension, by name. */
export function useProposer(extension: Extension) {
  const { workspace, chat } = useSession();
  return proposer(extension, workspace?.actors ?? [], chat.sessions);
}

/** What each part of an extension is. */
const parts: Record<string, { title: string; text: string }> = {
  kernel: {
    title: "Kernel module",
    text: "Runs inside the kernel, built for this computer",
  },
  process: {
    title: "Process",
    text: "Runs beside the kernel, as its own program",
  },
  interface: {
    title: "Interface",
    text: "Pages and panels drawn by the app, with your access",
  },
};
export const partOf = (part: string) =>
  parts[part] ?? { title: part, text: "" };

/** A category's name; one this app does not know yet is Other. */
export const categoryName = (id: string) =>
  extensionCategories.find((c) => c.id === id)?.name ?? "Other";

/** What a search finds: its words in a name, a description or a publisher. */
export const matches = (query: string) => {
  const words = query.toLowerCase().trim();
  return (e: { name: string; description: string; publisher: string }) =>
    !words ||
    `${e.name} ${e.description} ${e.publisher}`.toLowerCase().includes(words);
};

/** An extension's icon, from its card, for the theme; its initial when it has none. */
export function ExtensionIcon({
  id,
  name,
  card,
  large,
}: {
  id: string;
  name: string;
  card?: ExtensionCard | null;
  large?: boolean;
}) {
  const { url } = useSession();
  const { resolved } = useTheme();
  const icon = cardIcon(card, resolved === "dark");
  if (icon)
    return (
      <Image
        source={{ uri: cardFileUrl(icon, url) }}
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
        className={large ? "size-16 rounded-2xl" : "size-10 rounded-[10px]"}
      />
    );
  return (
    // Its initial is decoration: the name is said beside it.
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      className={cn(
        "items-center justify-center border border-border bg-muted",
        large ? "size-16 rounded-2xl" : "size-10 rounded-[10px]",
      )}
    >
      <Text
        className={cn(
          "font-semibold",
          authorColor(id),
          large ? "text-[28px]" : "text-lg",
        )}
      >
        {name.slice(0, 1).toUpperCase()}
      </Text>
    </View>
  );
}

/** A small rounded label: a state, a part, what an action does. */
export function Chip({
  children,
  tone,
}: {
  children: ReactNode;
  tone?: "on" | "off" | "error" | "attention" | "agent";
}) {
  return (
    <View
      className={cn(
        "flex-row items-center gap-1.5 self-start rounded-full border px-2 py-0.5",
        tone === "attention"
          ? "border-attention/45"
          : tone === "agent"
            ? "border-agent/45"
            : tone === "error"
              ? "border-destructive/45"
              : "border-border",
      )}
    >
      {tone === "on" || tone === "off" ? (
        <View
          className={cn(
            "size-1.5 rounded-full",
            tone === "on" ? "bg-success" : "bg-faint",
          )}
        />
      ) : null}
      <Text
        className={cn(
          "text-xs",
          tone === "attention"
            ? "text-attention"
            : tone === "agent"
              ? "text-agent-foreground"
              : tone === "error"
                ? "text-destructive"
                : "text-muted-foreground",
        )}
      >
        {children}
      </Text>
    </View>
  );
}

/** How an installed extension stands: its update first, then where it runs from, then its state. */
export function StateChip({
  extension,
  offer,
}: {
  extension: Extension;
  offer?: MarketplaceOffer;
}) {
  if (offer) return <Chip tone="attention">{offerVersions(offer)}</Chip>;
  if (extension.dev) return <Chip tone="agent">In development</Chip>;
  const { label, tone } = extensionState(extension);
  return <Chip tone={tone}>{label}</Chip>;
}

/**
 * An extension in a list: its mark, name, version and publisher, what it does, and under them
 * what the list says of it; a tap opens it.
 */
export function ExtensionRow({
  id,
  name,
  card,
  version,
  publisher,
  description,
  first,
  onPress,
  onLongPress,
  children,
}: {
  id: string;
  name: string;
  card?: ExtensionCard | null;
  version?: string;
  publisher: string;
  description: string;
  first: boolean;
  onPress: () => void;
  /** Its menu, on Android. */
  onLongPress?: () => void;
  children?: ReactNode;
}) {
  const faint = String(useCSSVariable("--color-faint"));
  return (
    // The whole row opens it to a touch; to those who hear the screen its name does, so the
    // row's own buttons stay theirs.
    <Pressable
      accessible={false}
      onPress={onPress}
      onLongPress={onLongPress}
      className={cn(
        "flex-row items-start gap-3 px-3.5 py-3 active:bg-accent",
        !first && "border-t border-border",
      )}
    >
      <ExtensionIcon id={id} name={name} card={card} />
      <View className="min-w-0 flex-1 gap-0.5">
        <View className="flex-row items-baseline gap-1.5">
          <Text
            accessibilityRole="button"
            onPress={onPress}
            numberOfLines={1}
            className="shrink text-[15px] font-semibold"
          >
            {name}
          </Text>
          {version ? (
            <Text className="font-mono text-xs text-faint">{version}</Text>
          ) : null}
          <Text
            numberOfLines={1}
            className="shrink text-[13px] text-muted-foreground"
          >
            {publisher}
          </Text>
        </View>
        {description ? (
          <Text numberOfLines={2} className="text-[13px] text-muted-foreground">
            {description}
          </Text>
        ) : null}
        {children ? (
          <View className="mt-1.5 flex-row flex-wrap items-center gap-2">
            {children}
          </View>
        ) : null}
      </View>
      <ChevronRightIcon color={faint} size={16} strokeWidth={1.5} />
    </Pressable>
  );
}

/** A row's own button: small beside its chips. */
export function RowButton({
  label,
  onPress,
  variant,
  disabled,
  danger,
}: {
  label: string;
  onPress: () => void;
  variant?: "default" | "outline" | "secondary" | "ghost";
  disabled?: boolean;
  danger?: boolean;
}) {
  return (
    <Button
      size="sm"
      variant={variant}
      className="h-8 px-3"
      disabled={disabled}
      onPress={onPress}
    >
      <Text className={cn("text-xs", danger && "text-destructive")}>
        {label}
      </Text>
    </Button>
  );
}

/** A labelled group of rows in a card. */
export function Group({
  label,
  count,
  children,
}: {
  label?: string;
  count?: number;
  children: ReactNode;
}) {
  return (
    <View className="gap-2">
      {label ? (
        <View className="flex-row items-baseline gap-2 px-1">
          <Text className="font-mono text-[11px] tracking-wider text-faint uppercase">
            {label}
          </Text>
          {count !== undefined ? (
            <Text className="font-mono text-[11px] text-faint">{count}</Text>
          ) : null}
        </View>
      ) : null}
      <View className="overflow-hidden rounded-xl border border-border bg-card">
        {children}
      </View>
    </View>
  );
}

/** A setting as it is edited: its text, or a switch. A secret starts empty. */
const draftOf = (setting: ExtensionSetting) =>
  setting.type === "boolean"
    ? setting.value === true
    : setting.type === "secret" || setting.value == null
      ? ""
      : String(setting.value);

const draftsOf = (extension: Extension) =>
  Object.fromEntries(extension.settings.map((s) => [s.key, draftOf(s)]));

/**
 * The owner's form for an extension's settings: each as its kind asks, a choice among its
 * options, a secret typed once and never shown again. Save sends only what changed.
 */
export function ExtensionSettings({
  extension,
  kernel,
}: {
  extension: Extension;
  kernel: string;
}) {
  const [drafts, setDrafts] = useState(() => draftsOf(extension));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const set = (key: string, draft: string | boolean) =>
    setDrafts((was) => ({ ...was, [key]: draft }));
  const changes = () => {
    const out: Record<string, unknown> = {};
    for (const setting of extension.settings) {
      const draft = drafts[setting.key];
      if (draft === draftOf(setting)) continue;
      if (setting.type === "secret") {
        if (typeof draft === "string" && draft.trim()) out[setting.key] = draft;
      } else if (setting.type === "number") {
        const text = String(draft).trim();
        if (!text) out[setting.key] = null;
        else if (Number.isFinite(Number(text))) out[setting.key] = Number(text);
        else throw new Error(`${setting.label} is not a number`);
      } else if (setting.type === "boolean") out[setting.key] = draft;
      else out[setting.key] = String(draft).trim() ? draft : null;
    }
    return out;
  };
  const save = async (next: Record<string, unknown>) => {
    setBusy(true);
    setError("");
    try {
      // What the kernel kept starts the form again: a secret sent is not sent twice.
      setDrafts(
        draftsOf(await setExtensionSettings(extension.id, next, kernel)),
      );
      extensionsNotice();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  let pending: Record<string, unknown> = {};
  let invalid = "";
  try {
    pending = changes();
  } catch (e) {
    invalid = errorMessage(e);
  }
  return (
    <View className="gap-5">
      {extension.settings.map((setting) => {
        const draft = drafts[setting.key];
        return (
          <View key={setting.key} className="gap-2">
            {setting.type === "boolean" ? (
              <View className="flex-row items-center gap-3">
                <Text className="flex-1 text-sm font-medium">
                  {setting.label}
                </Text>
                <Switch
                  accessibilityLabel={setting.label}
                  value={draft === true}
                  onValueChange={(on) => set(setting.key, on)}
                  disabled={busy}
                />
              </View>
            ) : setting.type === "choice" ? (
              <Choice
                label={setting.label}
                options={Object.fromEntries(
                  (setting.options ?? []).map((o) => [o.value, o.label]),
                )}
                value={typeof draft === "string" ? draft : ""}
                onChange={(next) => set(setting.key, next)}
                disabled={busy}
              />
            ) : (
              <>
                <Text className="text-sm font-medium">{setting.label}</Text>
                <Input
                  value={typeof draft === "string" ? draft : ""}
                  onChangeText={(next) => set(setting.key, next)}
                  editable={!busy}
                  autoCapitalize="none"
                  autoCorrect={false}
                  secureTextEntry={setting.type === "secret"}
                  // A key or a token, not a password iOS should offer to save.
                  textContentType={
                    setting.type === "secret" ? "oneTimeCode" : undefined
                  }
                  keyboardType={
                    setting.type === "number" ? "decimal-pad" : "default"
                  }
                  placeholder={
                    setting.type === "secret"
                      ? setting.set
                        ? "Set"
                        : "Not set"
                      : undefined
                  }
                  className={cn(setting.type === "secret" && "font-mono")}
                />
              </>
            )}
            {setting.description ? (
              <Text className="text-xs text-muted-foreground">
                {setting.description}
              </Text>
            ) : null}
            {setting.type === "secret" && setting.set ? (
              <Pressable
                accessibilityRole="button"
                disabled={busy}
                onPress={() => void save({ [setting.key]: null })}
                className="self-start"
              >
                <Text className="text-[13px] font-medium text-destructive">
                  Forget it
                </Text>
              </Pressable>
            ) : null}
          </View>
        );
      })}
      {invalid || error ? (
        <Text className="text-sm text-destructive">{invalid || error}</Text>
      ) : null}
      <Button
        disabled={busy || Boolean(invalid) || !Object.keys(pending).length}
        onPress={() => void save(pending)}
      >
        <Text>{busy ? "Saving…" : "Save"}</Text>
      </Button>
    </View>
  );
}
