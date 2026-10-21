import { Pressable, ScrollView, View } from "react-native";
import { useRouter } from "expo-router";
import {
  useUiPieces,
  harnessLabels,
  sessionState,
  sessionTone,
} from "@zerolux/chat";
import type { Actor, ChatSession, Conversation } from "@zerolux/chat";
import { ExtensionView } from "@/components/extension-view";
import { ActorMark } from "@/components/member";
import { Eyebrow } from "@/components/meter";
import { Text } from "@/components/ui/text";
import { cn } from "@/lib/utils";
import { useSession } from "../src/kernel";

/** About a chat: who is in it, what each is doing, and what extensions show for it. */
export function ChatAbout({
  conversation,
  actors,
  sessions,
}: {
  conversation: Conversation;
  actors: Actor[];
  sessions: ChatSession[];
}) {
  const router = useRouter();
  const { url } = useSession();
  const pieces = useUiPieces("chat", url);
  return (
    <ScrollView
      contentContainerClassName="gap-7 px-5 py-5"
      keyboardShouldPersistTaps="handled"
    >
      <View className="gap-1">
        <Eyebrow className="mb-1">
          Members · {conversation.members.length}
        </Eyebrow>
        {conversation.members.map((member) => {
          const actor = actors.find((a) => a.id === member.actor_id);
          const session = sessions.find((s) => s.id === member.session_id);
          const agent = actor?.kind !== "human";
          return (
            <Pressable
              key={member.actor_id}
              onPress={() => router.push(`/member/${member.actor_id}`)}
              className="-mx-2 flex-row items-center gap-3 rounded-sm px-2 py-2 active:bg-accent"
            >
              <ActorMark
                kind={agent ? "agent" : "human"}
                name={actor?.name ?? "?"}
                tone={session ? sessionTone(session) : undefined}
              />
              <View className="flex-1">
                <Text
                  numberOfLines={1}
                  className={cn(
                    "text-[15px] font-semibold",
                    agent && "font-mono font-medium text-agent-foreground",
                  )}
                >
                  {actor?.name ?? "Unknown"}
                </Text>
                <Text className="font-mono text-[11px] text-faint">
                  {!agent
                    ? "Person"
                    : actor?.harness
                      ? harnessLabels[actor.harness]
                      : "Agent"}
                </Text>
              </View>
              {session && (
                <Text
                  className={cn(
                    "text-xs",
                    session.status === "attention"
                      ? "text-attention"
                      : "text-faint",
                  )}
                >
                  {sessionState(session)}
                </Text>
              )}
            </Pressable>
          );
        })}
      </View>
      {pieces.map((piece) => (
        <View key={`${piece.extension}/${piece.name}`} className="gap-2">
          <Eyebrow className="mb-1">{piece.title}</Eyebrow>
          <ExtensionView
            piece={piece}
            context={{ conversation_id: conversation.id }}
          />
        </View>
      ))}
    </ScrollView>
  );
}
