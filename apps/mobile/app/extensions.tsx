import { useRouter } from "expo-router";
import { ChevronRightIcon } from "lucide-react-native";
import { useState } from "react";
import { Alert, Platform, Pressable, ScrollView, View } from "react-native";
import { useCSSVariable } from "uniwind";
import {
  errorMessage,
  loadExtensionFolder,
  useExtensions,
} from "@zerolux/chat";
import { extensionState, StateDot } from "@/components/extensions";
import { Screen } from "@/components/screen";
import { Button } from "@/components/ui/button";
import { Text } from "@/components/ui/text";
import { cn } from "@/lib/utils";
import { useSession } from "../src/kernel";
import { useMe } from "../src/me";

/**
 * The workspace's extensions, each with what it is and how it stands; a tap opens it. The
 * owner also loads one from a folder on the kernel's computer, in development.
 */
export default function Extensions() {
  const { url } = useSession();
  const { owner } = useMe();
  const { extensions, error } = useExtensions(url);
  const router = useRouter();
  const faint = String(useCSSVariable("--color-faint"));
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState("");
  const load = (folder: string) => {
    if (!folder.trim()) return;
    setBusy(true);
    setFailure("");
    loadExtensionFolder(folder.trim(), url)
      .then((extension) => router.push(`/extension/${extension.id}`))
      .catch((e: unknown) => setFailure(errorMessage(e)))
      .finally(() => setBusy(false));
  };
  return (
    <Screen back title="Extensions">
      <ScrollView contentContainerClassName="gap-4 px-5 pb-10 pt-2">
        <Text className="text-[15px] leading-[22px] text-muted-foreground">
          Extensions add actions, settings and tools for agents to the
          workspace.
        </Text>
        {error || failure ? (
          <Text className="text-sm text-destructive">{failure || error}</Text>
        ) : null}
        {extensions === undefined ? (
          <Text className="text-sm text-faint">Reading the extensions…</Text>
        ) : extensions.length === 0 ? (
          <Text className="text-sm text-faint">No extension is installed.</Text>
        ) : (
          <View className="overflow-hidden rounded-md border border-border bg-card">
            {extensions.map((extension, index) => {
              const state = extensionState(extension);
              return (
                <Pressable
                  key={extension.id}
                  accessibilityRole="button"
                  onPress={() => router.push(`/extension/${extension.id}`)}
                  className={cn(
                    "flex-row items-center gap-3 px-4 py-3 active:bg-accent",
                    index > 0 && "border-t border-border",
                  )}
                >
                  <StateDot extension={extension} />
                  <View className="min-w-0 flex-1">
                    <Text numberOfLines={1} className="text-[15px]">
                      {extension.name}
                    </Text>
                    <Text numberOfLines={1} className="text-xs text-faint">
                      {[
                        state.label,
                        extension.version,
                        extension.publisher,
                        extension.dev ? "from a folder" : null,
                      ]
                        .filter(Boolean)
                        .join(" · ")}
                    </Text>
                  </View>
                  <ChevronRightIcon color={faint} size={16} strokeWidth={1.5} />
                </Pressable>
              );
            })}
          </View>
        )}
        {owner && Platform.OS === "ios" ? (
          <Button
            variant="outline"
            disabled={busy}
            onPress={() =>
              Alert.prompt(
                "Load from a folder",
                "A folder with an extension, on the kernel's computer.",
                load,
                "plain-text",
              )
            }
          >
            <Text>Load from a folder</Text>
          </Button>
        ) : null}
      </ScrollView>
    </Screen>
  );
}
