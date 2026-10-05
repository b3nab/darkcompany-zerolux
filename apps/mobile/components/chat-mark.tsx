import { View } from "react-native";
import type { Actor, Conversation } from "@zerolux/chat";
import { ActorMark } from "@/components/member";
import { Text } from "@/components/ui/text";
import { cn } from "@/lib/utils";

/** A chat's mark: the agent of a direct chat, a group's initial on a wider tile. */
export function ChatMark({
  conversation,
  agent,
  small,
}: {
  conversation: Conversation;
  agent?: Actor;
  small?: boolean;
}) {
  if (agent)
    return (
      <ActorMark kind="agent" name={agent.name} size={small ? "md" : "lg"} />
    );
  return (
    <View
      className={cn(
        "items-center justify-center border border-input bg-secondary",
        small ? "size-8 rounded-md" : "size-14 rounded-xl",
      )}
    >
      <Text className={cn("font-semibold", small ? "text-sm" : "text-lg")}>
        {conversation.title.slice(0, 1).toUpperCase()}
      </Text>
    </View>
  );
}
