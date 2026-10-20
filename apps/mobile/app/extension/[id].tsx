import { useLocalSearchParams, useRouter } from "expo-router";
import { ChevronRightIcon } from "lucide-react-native";
import { useState } from "react";
import { Alert, Pressable, ScrollView, Switch, View } from "react-native";
import { useCSSVariable } from "uniwind";
import {
  disableExtension,
  enableExtension,
  errorMessage,
  loadExtensionFolder,
  removeExtension,
  useActions,
  useExtensions,
} from "@zerolux/chat";
import {
  ExtensionSettings,
  extensionState,
  StateDot,
} from "@/components/extensions";
import { Screen } from "@/components/screen";
import { Button } from "@/components/ui/button";
import { Text } from "@/components/ui/text";
import { cn } from "@/lib/utils";
import { useSession } from "../../src/kernel";
import { useMe } from "../../src/me";

/**
 * One extension: what it is, how it stands and why, and its actions, each run from its own
 * form. The owner enables or disables it, sets its settings, loads it again from its folder
 * in development, and removes it.
 */
export default function ExtensionPage() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { url } = useSession();
  const { owner } = useMe();
  const router = useRouter();
  const faint = String(useCSSVariable("--color-faint"));
  const { extensions, error } = useExtensions(url);
  const actions = useActions(url).actions?.filter((a) => a.extension === id);
  const extension = extensions?.find((e) => e.id === id);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState("");
  const act = (work: () => Promise<unknown>) => {
    setBusy(true);
    setFailure("");
    work()
      .catch((e: unknown) => setFailure(errorMessage(e)))
      .finally(() => setBusy(false));
  };
  if (!extension)
    return (
      <Screen back title="Extension">
        <Text className="px-5 pt-2 text-sm text-faint">
          {error || (extensions ? "This extension is gone." : "Reading it…")}
        </Text>
      </Screen>
    );
  const state = extensionState(extension);
  const dependencies = Object.entries(extension.dependencies);
  return (
    <Screen back title={extension.name} subtitle={extension.version}>
      <ScrollView
        contentContainerClassName="gap-6 px-5 pb-10 pt-2"
        keyboardShouldPersistTaps="handled"
      >
        <View className="gap-2">
          {extension.description ? (
            <Text className="text-[15px] leading-[22px]">
              {extension.description}
            </Text>
          ) : null}
          <View className="flex-row items-center gap-2">
            <StateDot extension={extension} />
            <Text className="text-sm text-muted-foreground">
              {[
                state.label,
                extension.publisher,
                extension.dev ? "In development" : null,
              ]
                .filter(Boolean)
                .join(" · ")}
            </Text>
          </View>
          {extension.error ? (
            <Text className="text-sm text-destructive">{extension.error}</Text>
          ) : null}
          {dependencies.length ? (
            <Text className="text-xs text-faint">
              Needs{" "}
              {dependencies
                .map(([name, range]) => `${name} ${range}`)
                .join(", ")}
            </Text>
          ) : null}
          {failure ? (
            <Text className="text-sm text-destructive">{failure}</Text>
          ) : null}
        </View>
        {owner ? (
          <View className="gap-3">
            <View className="flex-row items-center gap-3">
              <Text className="flex-1 text-base">Enabled</Text>
              <Switch
                accessibilityLabel={`Enable ${extension.name}`}
                value={extension.enabled}
                disabled={busy}
                onValueChange={(on) =>
                  act(() =>
                    on
                      ? enableExtension(extension.id, url)
                      : disableExtension(extension.id, url),
                  )
                }
              />
            </View>
            <View className="flex-row flex-wrap gap-2">
              {extension.dev ? (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy}
                  onPress={() =>
                    act(() => loadExtensionFolder(extension.source, url))
                  }
                >
                  <Text>Load again</Text>
                </Button>
              ) : null}
              <Button
                size="sm"
                variant="outline"
                disabled={busy}
                onPress={() =>
                  Alert.alert(
                    `Remove ${extension.name}?`,
                    "Its settings and data are deleted.",
                    [
                      { text: "Cancel", style: "cancel" },
                      {
                        text: "Remove",
                        style: "destructive",
                        onPress: () =>
                          act(async () => {
                            await removeExtension(extension.id, url);
                            router.back();
                          }),
                      },
                    ],
                  )
                }
              >
                <Text className="text-destructive">Remove</Text>
              </Button>
            </View>
          </View>
        ) : null}
        {owner && extension.settings.length ? (
          <View className="gap-3">
            <Text className="text-sm text-faint">Settings</Text>
            <ExtensionSettings extension={extension} kernel={url} />
          </View>
        ) : null}
        {actions?.length ? (
          <View className="gap-1">
            <Text className="text-sm text-faint">Actions</Text>
            <View className="overflow-hidden rounded-md border border-border bg-card">
              {actions.map((action, index) => (
                <Pressable
                  key={action.name}
                  accessibilityRole="button"
                  onPress={() =>
                    router.push({
                      pathname: "/action",
                      params: { extension: extension.id, name: action.name },
                    })
                  }
                  className={cn(
                    "flex-row items-center gap-3 px-4 py-3 active:bg-accent",
                    index > 0 && "border-t border-border",
                  )}
                >
                  <View className="min-w-0 flex-1">
                    <Text numberOfLines={1} className="text-[15px]">
                      {action.title}
                    </Text>
                    {action.description ? (
                      <Text numberOfLines={2} className="text-xs text-faint">
                        {action.description}
                      </Text>
                    ) : null}
                  </View>
                  {action.effects === "destructive" ? (
                    <Text className="text-xs text-destructive">
                      Destructive
                    </Text>
                  ) : null}
                  <ChevronRightIcon color={faint} size={16} strokeWidth={1.5} />
                </Pressable>
              ))}
            </View>
          </View>
        ) : null}
      </ScrollView>
    </Screen>
  );
}
