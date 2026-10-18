import { useLocalSearchParams, useRouter } from "expo-router";
import { SearchIcon, XIcon } from "lucide-react-native";
import { useState } from "react";
import { Pressable, ScrollView, TextInput, View } from "react-native";
import { useCSSVariable } from "uniwind";
import { folderName, useSessionFiles } from "@zerolux/chat";
import { Screen } from "@/components/screen";
import { Text } from "@/components/ui/text";
import { useSession } from "../../src/kernel";

/**
 * The files of a session's folder, found by what the owner types, best first (in a git
 * repository, those git tracks or would track); a tap opens one.
 */
export default function FilesPage() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { chat, url } = useSession();
  const router = useRouter();
  const faint = String(useCSSVariable("--color-faint"));
  const session = chat.sessions.find((s) => s.id === id);
  const [query, setQuery] = useState("");
  const files = useSessionFiles(id, query.trim(), url);
  return (
    <Screen
      back
      title="Files"
      subtitle={session ? folderName(session.workspace) : undefined}
    >
      <View className="mx-4 mt-3 mb-1 flex-row items-center gap-2 rounded-md bg-muted px-2.5">
        <SearchIcon color={faint} size={16} strokeWidth={1.75} />
        <TextInput
          value={query}
          onChangeText={setQuery}
          autoFocus
          placeholder="Find a file"
          placeholderTextColor={faint}
          autoCorrect={false}
          autoCapitalize="none"
          returnKeyType="search"
          accessibilityLabel="Find a file"
          className="flex-1 py-2 font-mono text-[14px] text-foreground"
        />
        {query ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Clear"
            onPress={() => setQuery("")}
            hitSlop={8}
          >
            <XIcon color={faint} size={16} strokeWidth={1.75} />
          </Pressable>
        ) : null}
      </View>
      <ScrollView
        className="flex-1"
        contentContainerClassName="py-2"
        keyboardDismissMode="on-drag"
        keyboardShouldPersistTaps="handled"
      >
        {files.map((path) => (
          <Pressable
            key={path}
            accessibilityRole="button"
            onPress={() =>
              router.push({ pathname: "/file/[id]", params: { id, path } })
            }
            className="px-4 py-2 active:bg-accent"
          >
            <Text numberOfLines={1} className="text-[15px]">
              {path.split("/").at(-1)}
            </Text>
            {path.includes("/") ? (
              <Text
                numberOfLines={1}
                className="font-mono text-[11.5px] text-faint"
              >
                {path.split("/").slice(0, -1).join("/")}
              </Text>
            ) : null}
          </Pressable>
        ))}
        {!files.length && query.trim() ? (
          <Text className="px-4 py-2 text-sm text-faint">
            No file matches "{query.trim()}".
          </Text>
        ) : null}
      </ScrollView>
    </Screen>
  );
}
