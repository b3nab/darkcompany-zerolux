import { useLocalSearchParams, useRouter } from "expo-router";
import { useState } from "react";
import { ScrollView, TextInput, View } from "react-native";
import { useCSSVariable } from "uniwind";
import { errorMessage, useBackgroundCommands } from "@zerolux/chat";
import { Screen } from "@/components/screen";
import { BackgroundList } from "@/components/background";
import { Button } from "@/components/ui/button";
import { Text } from "@/components/ui/text";
import { useSession } from "../../src/kernel";
import { useAccess } from "../../src/me";

/**
 * What a session runs in the background, beside its terminal: each command and how it stands.
 * Whoever works in the session runs a new one, and its output opens.
 */
export default function BackgroundPage() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { chat, url } = useSession();
  const session = chat.sessions.find((s) => s.id === id);
  const { write } = useAccess(session);
  const background = useBackgroundCommands(session ? id : undefined, url);
  const router = useRouter();
  const faint = String(useCSSVariable("--color-faint"));
  const [command, setCommand] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const run = () => {
    if (!command.trim()) return;
    setBusy(true);
    setError("");
    background
      .run(command.trim())
      .then((started) => {
        setCommand("");
        router.push({
          pathname: "/background-command/[id]",
          params: { id: started.id, session: id },
        });
      })
      .catch((e: unknown) => setError(errorMessage(e)))
      .finally(() => setBusy(false));
  };
  return (
    <Screen back title="Background" subtitle={session?.title || undefined}>
      {session ? (
        <ScrollView
          contentContainerClassName="gap-4 px-5 pb-10 pt-2"
          keyboardShouldPersistTaps="handled"
        >
          {write ? (
            <View className="gap-2">
              <View className="flex-row items-center gap-2">
                <TextInput
                  value={command}
                  onChangeText={setCommand}
                  onSubmitEditing={run}
                  placeholder="Command"
                  placeholderTextColor={faint}
                  autoCapitalize="none"
                  autoCorrect={false}
                  returnKeyType="go"
                  editable={!busy}
                  className="h-10 flex-1 rounded-md border border-input bg-background px-3 font-mono text-[14px] text-foreground"
                />
                <Button disabled={busy || !command.trim()} onPress={run}>
                  <Text>{busy ? "Starting…" : "Run in background"}</Text>
                </Button>
              </View>
              {error ? (
                <Text className="text-xs text-destructive">{error}</Text>
              ) : null}
            </View>
          ) : null}
          <BackgroundList
            session={session}
            commands={background.commands}
            error={background.error}
          />
        </ScrollView>
      ) : (
        <Text className="px-5 pt-2 text-sm text-faint">
          This session is no longer listed.
        </Text>
      )}
    </Screen>
  );
}
