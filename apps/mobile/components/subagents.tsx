import { useRouter } from "expo-router";
import { ChevronRightIcon } from "lucide-react-native";
import { createContext, use } from "react";
import { Pressable, View } from "react-native";
import { useCSSVariable } from "uniwind";
import { ago, subagentName } from "@zerolux/chat";
import type { Subagent } from "@zerolux/chat";
import { Text } from "@/components/ui/text";

/** From a tool call that started a subagent, the way to open its work; none when unknown. */
export const SubagentLinks = createContext<
  (toolCallId: string) => (() => void) | undefined
>(() => undefined);
export const useSubagentLink = (toolCallId: string) =>
  use(SubagentLinks)(toolCallId);

/** The links of a session's subagents to their own screens. */
export function useSubagentLinks(sessionId: string, subagents?: Subagent[]) {
  const router = useRouter();
  return (toolCallId: string) => {
    const subagent = subagents?.find((s) => s.tool_call_id === toolCallId);
    return subagent
      ? () =>
          router.push({
            pathname: "/subagent/[id]",
            params: { id: sessionId, agent: subagent.id },
          })
      : undefined;
  };
}

/** In About: the subagents the session started, the latest first; a tap opens one's work. */
export function SubagentList({
  sessionId,
  subagents,
  close,
}: {
  sessionId: string;
  subagents?: Subagent[];
  close: () => void;
}) {
  const router = useRouter();
  const faint = String(useCSSVariable("--color-faint"));
  if (!subagents?.length) return null;
  return (
    <View className="gap-1">
      <Text className="text-sm text-faint">Subagents · {subagents.length}</Text>
      {subagents.map((subagent) => (
        <Pressable
          key={subagent.id}
          accessibilityRole="button"
          onPress={() => {
            close();
            router.push({
              pathname: "/subagent/[id]",
              params: { id: sessionId, agent: subagent.id },
            });
          }}
          className="flex-row items-center gap-2.5 py-2 active:opacity-70"
        >
          <View className="min-w-0 flex-1">
            <Text numberOfLines={1} className="text-[15px]">
              {subagentName(subagent)}
            </Text>
            <Text numberOfLines={1} className="text-xs text-faint">
              {[
                subagent.kind !== subagent.name ? subagent.kind : null,
                subagent.description,
                subagent.updated_at ? ago(subagent.updated_at) : null,
              ]
                .filter(Boolean)
                .join(" · ")}
            </Text>
          </View>
          <ChevronRightIcon color={faint} size={16} strokeWidth={1.5} />
        </Pressable>
      ))}
    </View>
  );
}
