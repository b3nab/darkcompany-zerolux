import { Image, Linking, Pressable, ScrollView, View } from "react-native";
import { useRouter } from "expo-router";
import {
  fileKind,
  fileSize,
  fileUrl,
  harnessLabels,
  sessionState,
  sessionTone,
} from "@zerolux/chat";
import type { Actor, ChatSession, Conversation, Storage } from "@zerolux/chat";
import { FileGlyph } from "@/components/file";
import { ActorMark } from "@/components/member";
import { Eyebrow } from "@/components/meter";
import { Text } from "@/components/ui/text";
import { cn } from "@/lib/utils";

/** About a chat: who is in it and what each is doing, its tasks, and the files shared in it. */
export function ChatAbout({
  conversation,
  actors,
  sessions,
  storage,
}: {
  conversation: Conversation;
  actors: Actor[];
  sessions: ChatSession[];
  storage: Storage;
}) {
  const router = useRouter();
  const files = storage.files
    .filter((f) => f.conversation_id === conversation.id)
    .sort((a, b) => b.updated_at - a.updated_at);
  const images = files.filter((f) => fileKind(f) === "image");
  const others = files.filter((f) => !images.includes(f));
  const open = (url: string) => void Linking.openURL(url);
  return (
    <ScrollView contentContainerClassName="gap-7 px-5 py-5">
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
      <View className="gap-2">
        <Eyebrow>Tasks from this chat</Eyebrow>
        {/* TODO: kernel: tasks started from a chat message, listed by chat, each with its status. */}
        <Text className="text-sm text-muted-foreground">No tasks yet.</Text>
      </View>
      <View className="gap-2.5">
        <Eyebrow>Files · {files.length}</Eyebrow>
        {images.length > 0 && (
          <View className="flex-row flex-wrap gap-1.5">
            {images.map((file) => (
              <Pressable
                key={file.id}
                onPress={() => open(fileUrl(file))}
                style={{ width: "32%" }}
                accessibilityLabel={file.name}
              >
                <Image
                  source={{ uri: fileUrl(file) }}
                  className="rounded-sm border border-border"
                  style={{ width: "100%", aspectRatio: 1 }}
                />
              </Pressable>
            ))}
          </View>
        )}
        {others.map((file) => (
          <Pressable
            key={file.id}
            onPress={() => open(fileUrl(file))}
            className="-mx-2 flex-row items-center gap-3 rounded-sm px-2 py-2 active:bg-accent"
          >
            <FileGlyph
              file={file}
              by={
                actors.find((a) => a.id === file.created_by)?.kind === "human"
                  ? "human"
                  : "agent"
              }
            />
            <Text numberOfLines={1} className="flex-1 text-sm">
              {file.name}
            </Text>
            <Text className="font-mono text-[11px] text-faint">
              {fileSize(file.size)}
            </Text>
          </Pressable>
        ))}
        {files.length === 0 && (
          <Text className="text-sm text-muted-foreground">
            {storage.error ||
              (storage.available
                ? "No files shared here yet."
                : "This kernel has no storage yet.")}
          </Text>
        )}
      </View>
    </ScrollView>
  );
}
