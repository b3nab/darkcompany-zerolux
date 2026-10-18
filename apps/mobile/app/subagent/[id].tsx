import { useLocalSearchParams } from "expo-router";
import { useMemo } from "react";
import {
  blockRuns,
  sessionBlocks,
  subagentName,
  useArrivals,
  useSessionEvents,
  useSessionSubagents,
} from "@zerolux/chat";
import type { BlockRun, SessionBlock } from "@zerolux/chat";
import { Screen } from "@/components/screen";
import { SessionRunView } from "@/components/session-blocks";
import { SubagentLinks, useSubagentLinks } from "@/components/subagents";
import { ChatList } from "@/components/ui/native";
import { Text } from "@/components/ui/text";
import { useSession } from "../../src/kernel";

/**
 * A subagent's work, as a session's reads: what it was asked, its reasoning, its tools and its
 * answer, turn by turn, followed while the session's record grows. One it started opens too.
 */
export default function SubagentPage() {
  const { id, agent } = useLocalSearchParams<{ id: string; agent: string }>();
  const { chat, url } = useSession();
  const grown = chat.outputs[id]?.end;
  const { events, error, more, earlier } = useSessionEvents(id, grown, agent);
  const { subagents } = useSessionSubagents(id, grown, url);
  const subagent = subagents?.find((s) => s.id === agent);
  const blocks = useMemo(() => sessionBlocks(events), [events]);
  const runs = useMemo(() => blockRuns(blocks), [blocks]);
  const fresh = useArrivals(blocks);
  const links = useSubagentLinks(id, subagents);
  return (
    <Screen
      back
      title={subagent ? subagentName(subagent) : "Subagent"}
      subtitle={subagent?.description ?? subagent?.kind ?? undefined}
    >
      <SubagentLinks value={links}>
        <ChatList
          data={runs}
          keyExtractor={(run) => (run as BlockRun<SessionBlock>).key}
          renderItem={({ item }) => (
            <SessionRunView
              run={item as BlockRun<SessionBlock>}
              fresh={fresh}
            />
          )}
          contentContainerClassName="gap-3 px-3 pt-3 pb-3"
          alignItemsAtEnd
          initialScrollAtEnd
          maintainScrollAtEnd
          onStartReached={more ? earlier : undefined}
          onStartReachedThreshold={0.4}
          ListEmptyComponent={
            <Text
              className={
                error ? "text-sm text-destructive" : "text-sm text-faint"
              }
            >
              {error || "Nothing recorded yet."}
            </Text>
          }
        />
      </SubagentLinks>
    </Screen>
  );
}
