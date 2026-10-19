import * as Haptics from "expo-haptics";
import { useLocalSearchParams } from "expo-router";
import { useState } from "react";
import { Alert, ScrollView, View } from "react-native";
import {
  errorMessage,
  runAction,
  useActionForm,
  useActions,
} from "@zerolux/chat";
import type { ExtensionAction } from "@zerolux/chat";
import { ActionForm } from "@/components/action-form";
import { Screen } from "@/components/screen";
import { Button } from "@/components/ui/button";
import { Text } from "@/components/ui/text";
import { useSession } from "../src/kernel";

/** An extension's action, run as people and agents run it: its form, then its result. */
export default function ActionPage() {
  const { extension, name } = useLocalSearchParams<{
    extension: string;
    name: string;
  }>();
  const { url } = useSession();
  const { actions, error } = useActions(url);
  const action = actions?.find(
    (a) => a.extension === extension && a.name === name,
  );
  return (
    <Screen back="close" title={action?.title ?? "Action"}>
      {action ? (
        <Run key={`${extension}/${name}`} action={action} kernel={url} />
      ) : (
        <Text className="px-5 pt-2 text-sm text-faint">
          {error ||
            (actions ? "This action is not available now." : "Reading it…")}
        </Text>
      )}
    </Screen>
  );
}

function Run({ action, kernel }: { action: ExtensionAction; kernel: string }) {
  const form = useActionForm(action.input);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<{ value: unknown }>();
  const run = (input: Record<string, unknown>) => {
    setBusy(true);
    setError("");
    setResult(undefined);
    runAction(action.extension, action.name, input, kernel)
      .then((value) => {
        setResult({ value });
        void Haptics.notificationAsync(
          Haptics.NotificationFeedbackType.Success,
        );
      })
      .catch((e: unknown) => setError(errorMessage(e)))
      .finally(() => setBusy(false));
  };
  const submit = () => {
    const input = form.submit();
    if (!input) return;
    if (action.effects !== "destructive") return run(input);
    Alert.alert(`${action.title}?`, "It deletes or overwrites data.", [
      { text: "Cancel", style: "cancel" },
      { text: action.title, style: "destructive", onPress: () => run(input) },
    ]);
  };
  const minutes = action.seconds ? Math.round(action.seconds / 60) : 0;
  return (
    <ScrollView
      contentContainerClassName="gap-5 px-5 pb-10 pt-2"
      keyboardShouldPersistTaps="handled"
    >
      {action.description ? (
        <Text className="text-[15px] leading-[22px] text-muted-foreground">
          {action.description}
        </Text>
      ) : null}
      <ActionForm {...form} disabled={busy} />
      {minutes > 1 ? (
        <Text className="text-xs text-faint">
          It can take up to {minutes} minutes.
        </Text>
      ) : null}
      <Button
        variant={action.effects === "destructive" ? "destructive" : "default"}
        disabled={busy}
        onPress={submit}
      >
        <Text>{busy ? "Running…" : action.title}</Text>
      </Button>
      {error ? <Text className="text-sm text-destructive">{error}</Text> : null}
      {result ? (
        <View className="gap-2">
          <Text className="text-sm text-faint">Result</Text>
          <Text
            selectable
            className="rounded-md border border-border bg-card px-3 py-2.5 font-mono text-[13px] leading-5"
          >
            {result.value === undefined || result.value === null
              ? "Done."
              : typeof result.value === "string"
                ? result.value
                : JSON.stringify(result.value, null, 2)}
          </Text>
        </View>
      ) : null}
    </ScrollView>
  );
}
