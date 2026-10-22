import { useCallback, useState } from "react";
import { FlatList, Modal, Pressable, View } from "react-native";
import { agentMembers, listChats } from "@zerolux/chat";
import { ChatMark } from "@/components/chat-mark";
import { SearchField } from "@/components/search-field";
import { Text } from "@/components/ui/text";
import { useSession } from "../src/kernel";

/**
 * A chat to choose, asked by a view: a sheet of the person's chats with a search, the chat
 * chosen or none when it is closed. The sheet goes in the tree.
 */
export function useChatChooser() {
  const { chat, actors } = useSession();
  const [asked, setAsked] = useState<{
    title: string;
    answer: (id: string | null) => void;
  }>();
  const [query, setQuery] = useState("");
  const choose = useCallback(
    (title: string) =>
      new Promise<string | null>((answer) => {
        setQuery("");
        setAsked({ title, answer });
      }),
    [],
  );
  const close = (id: string | null) => {
    asked?.answer(id);
    setAsked(undefined);
  };
  const words = query.trim().toLowerCase();
  const shown = listChats(chat.conversations, "all", new Set()).filter(
    (c) => !words || c.title.toLowerCase().includes(words),
  );
  const sheet = asked ? (
    <Modal
      visible
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={() => close(null)}
    >
      <View className="flex-1 bg-background">
        <View className="flex-row items-center gap-3 border-b border-border px-5 py-3">
          <Pressable
            accessibilityRole="button"
            onPress={() => close(null)}
            hitSlop={12}
          >
            <Text className="text-base font-medium text-human-foreground">
              Cancel
            </Text>
          </Pressable>
          <Text
            numberOfLines={1}
            className="flex-1 text-center text-[17px] font-semibold"
          >
            {asked.title}
          </Text>
          <View className="w-14" />
        </View>
        <SearchField
          value={query}
          onChange={setQuery}
          label="Search chats"
          className="mx-4 mt-3 mb-1"
        />
        <FlatList
          data={shown}
          keyExtractor={(c) => c.id}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="on-drag"
          contentContainerClassName="py-2"
          ListEmptyComponent={
            <Text className="p-5 text-sm text-faint">No chats</Text>
          }
          renderItem={({ item: c }) => (
            <Pressable
              accessibilityRole="button"
              onPress={() => close(c.id)}
              className="flex-row items-center gap-3 px-5 py-2 active:bg-accent"
            >
              <ChatMark
                conversation={c}
                agent={c.kind === "dm" ? agentMembers(c, actors)[0] : undefined}
                small
              />
              <Text numberOfLines={1} className="flex-1 text-base">
                {c.title}
              </Text>
            </Pressable>
          )}
        />
      </View>
    </Modal>
  ) : null;
  return [choose, sheet] as const;
}
