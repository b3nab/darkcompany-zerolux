import { useState } from "react";
import { Pressable, Switch, View } from "react-native";
import { errorMessage, setExtensionSettings } from "@zerolux/chat";
import type { Extension, ExtensionSetting } from "@zerolux/chat";
import { Choice } from "@/components/choice";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Text } from "@/components/ui/text";
import { cn } from "@/lib/utils";

/** How an extension stands: running, enabled but stopped, off, or failed with its reason. */
export function extensionState(extension: Extension) {
  if (extension.error) return { label: "Error", tone: "error" as const };
  if (!extension.enabled) return { label: "Disabled", tone: "off" as const };
  return extension.running
    ? { label: "Running", tone: "on" as const }
    : { label: "Enabled", tone: "off" as const };
}

/** The dot of an extension's state, as a light. */
export function StateDot({ extension }: { extension: Extension }) {
  const { tone } = extensionState(extension);
  return (
    <View
      className={cn(
        "size-2 rounded-full",
        tone === "on"
          ? "bg-success"
          : tone === "error"
            ? "bg-destructive"
            : "bg-faint",
      )}
    />
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
                        ? "Set: type a new one to replace it"
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
