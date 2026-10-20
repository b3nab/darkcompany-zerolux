import { useLocalSearchParams } from "expo-router";
import { useMemo } from "react";
import { ActivityIndicator, ScrollView, View } from "react-native";
import { useCSSVariable } from "uniwind";
import { uiPieces, useExtensions } from "@zerolux/chat";
import type { UiContext, UiSpace } from "@zerolux/chat";
import { ExtensionView } from "@/components/extension-view";
import { Screen } from "@/components/screen";
import { Text } from "@/components/ui/text";
import { useSession } from "../src/kernel";

/** An extension's page, or its panel for a session, on a screen of its own. */
export default function PiecePage() {
  const { extension, name, space, session } = useLocalSearchParams<{
    extension: string;
    name: string;
    space: UiSpace;
    session?: string;
  }>();
  const { url } = useSession();
  const { extensions, error } = useExtensions(url);
  const muted = String(useCSSVariable("--color-muted-foreground"));
  const piece = extensions
    ? uiPieces(extensions, space).find(
        (p) => p.extension === extension && p.name === name,
      )
    : undefined;
  const context = useMemo<UiContext>(
    () => (session ? { session_id: session } : {}),
    [session],
  );
  return (
    <Screen back title={piece?.title ?? "Extension"}>
      {piece ? (
        piece.view.kind === "web" ? (
          <View className="flex-1 px-3 pt-2 pb-6">
            <ExtensionView piece={piece} context={context} fill />
          </View>
        ) : (
          <ScrollView contentContainerClassName="gap-4 px-5 pt-2 pb-10">
            <ExtensionView piece={piece} context={context} />
          </ScrollView>
        )
      ) : extensions || error ? (
        <Text className="px-5 pt-2 text-sm text-faint">
          {error || "This extension is not enabled."}
        </Text>
      ) : (
        <ActivityIndicator size="small" color={muted} className="mt-6" />
      )}
    </Screen>
  );
}
