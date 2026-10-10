import { useRouter } from "expo-router";
import { SquarePenIcon } from "lucide-react-native";
import { useState } from "react";
import { FlatList, Pressable, View } from "react-native";
import {
  agentMembers,
  chatFilters,
  chatPreview,
  harnessLabels,
  listChats,
  listTime,
  unreadIn,
  waitingChats,
} from "@zerolux/chat";
import type { ChatFilter } from "@zerolux/chat";
import { useCSSVariable } from "uniwind";
import { ChatMark } from "@/components/chat-mark";
import { Screen } from "@/components/screen";
import { Text } from "@/components/ui/text";
import { cn } from "@/lib/utils";
import { useSession } from "../../src/kernel";

/** Every chat, the newest activity first; the ones waiting for you are marked. */
export default function Chats() {
  const { chat, actors, name } = useSession();
  const router = useRouter();
  const [filter, setFilter] = useState<ChatFilter>("all");
  const ink = String(useCSSVariable("--color-foreground"));
  const waiting = waitingChats(
    chat.conversations,
    chat.approvals,
    chat.sessions,
  );
  const chats = listChats(chat.conversations, filter, waiting);
  return (
    <Screen
      title="Chats"
      action={
        <Pressable
          onPress={() => router.push("/chat/new")}
          accessibilityRole="button"
          accessibilityLabel="New chat"
          hitSlop={8}
          className="size-10 items-center justify-center rounded-sm active:bg-accent"
        >
          <SquarePenIcon color={ink} size={22} strokeWidth={1.5} />
        </Pressable>
      }
    >
      <View className="mx-5 mb-2 flex-row self-start rounded-sm border border-border bg-sidebar p-0.5">
        {(Object.keys(chatFilters) as ChatFilter[]).map((f) => (
          <Pressable
            key={f}
            onPress={() => setFilter(f)}
            accessibilityRole="button"
            accessibilityState={{ selected: filter === f }}
            className={cn(
              "flex-row gap-1.5 rounded-[3px] px-3 py-1.5",
              filter === f && "bg-secondary",
            )}
          >
            <Text
              className={cn(
                "text-[13px] font-medium",
                filter === f ? "text-foreground" : "text-muted-foreground",
              )}
            >
              {chatFilters[f]}
            </Text>
            {f === "you" && waiting.size > 0 ? (
              <Text className="font-mono text-[12px] text-attention">
                {waiting.size}
              </Text>
            ) : null}
          </Pressable>
        ))}
      </View>
      {chat.error ? (
        <Text className="px-5 pb-2 text-sm text-destructive">{chat.error}</Text>
      ) : null}
      <FlatList
        data={chats}
        keyExtractor={(c) => c.id}
        contentContainerClassName="pb-4"
        ListEmptyComponent={
          <Text className="p-5 text-base leading-6 text-faint">
            {filter === "you"
              ? "Nothing is waiting for you."
              : filter === "groups"
                ? "No group chats yet."
                : "No chats yet. Start one with the pencil above."}
          </Text>
        }
        renderItem={({ item: c }) => {
          const agent =
            c.kind === "dm" ? agentMembers(c, actors)[0] : undefined;
          const unread = unreadIn(c, chat.seen);
          const asks = waiting.has(c.id);
          const last = c.last_message;
          const preview = chatPreview(
            c,
            chat.conversations,
            chat.sessions,
            name,
          );
          return (
            <Pressable
              className="flex-row items-center gap-3 px-5 py-2.5 active:bg-accent"
              onPress={() => router.push(`/chat/${c.id}`)}
            >
              <ChatMark conversation={c} agent={agent} />
              <View className="min-w-0 flex-1 gap-0.5">
                <View className="flex-row items-baseline gap-2">
                  <Text
                    className="shrink text-base font-medium"
                    numberOfLines={1}
                  >
                    {c.title}
                  </Text>
                  {agent?.harness ? (
                    <Text className="font-mono text-[11px] text-faint">
                      {harnessLabels[agent.harness]}
                    </Text>
                  ) : null}
                  {last ? (
                    <Text className="ml-auto font-mono text-[11px] text-faint">
                      {listTime(last.created_at)}
                    </Text>
                  ) : null}
                </View>
                <View className="flex-row items-center gap-2">
                  <Text
                    className={cn(
                      "flex-1 text-sm",
                      preview.working
                        ? "text-agent-foreground"
                        : "text-muted-foreground",
                    )}
                    numberOfLines={1}
                  >
                    {preview.text}
                  </Text>
                  {unread > 0 || asks ? (
                    <View
                      accessibilityLabel={
                        asks ? "Waiting for you" : `${unread} new messages`
                      }
                      className={cn(
                        "h-5 min-w-5 items-center justify-center rounded-full px-1.5",
                        asks ? "bg-attention" : "bg-foreground",
                      )}
                    >
                      <Text
                        className={cn(
                          "font-mono text-[11px] font-medium",
                          asks
                            ? "text-attention-foreground"
                            : "text-background",
                        )}
                      >
                        {unread > 99 ? "99+" : unread || "!"}
                      </Text>
                    </View>
                  ) : null}
                </View>
              </View>
            </Pressable>
          );
        }}
      />
    </Screen>
  );
}
