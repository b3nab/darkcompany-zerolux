import { useState } from "react";
import { Pressable, View } from "react-native";
import { LegendList } from "@legendapp/list/react-native";
import { consoleSessions } from "@zerolux/chat";
import { Screen } from "@/components/screen";
import { SessionRow } from "@/components/session";
import { Text } from "@/components/ui/text";
import { cn } from "@/lib/utils";
import { useSession } from "../../src/kernel";

/** The Agent Console: the live sessions, working first; the stopped ones on request. */
export default function Console() {
  const { workspace, chat } = useSession();
  const [stopped, setStopped] = useState(false);
  const sessions = consoleSessions(chat.sessions);
  const shown = stopped ? sessions.stopped : sessions.live;
  return (
    <Screen title="Console">
      <View className="mx-5 mb-2 flex-row self-start rounded-sm border border-border bg-sidebar p-0.5">
        {(
          [
            [false, "Live", sessions.live.length],
            [true, "Stopped", sessions.stopped.length],
          ] as const
        ).map(([value, label, count]) => (
          <Pressable
            key={label}
            onPress={() => setStopped(value)}
            accessibilityRole="button"
            accessibilityState={{ selected: stopped === value }}
            className={cn(
              "flex-row gap-1.5 rounded-[3px] px-3 py-1.5",
              stopped === value && "bg-secondary",
            )}
          >
            <Text
              className={cn(
                "text-[13px] font-medium",
                stopped === value ? "text-foreground" : "text-muted-foreground",
              )}
            >
              {label}
            </Text>
            <Text className="font-mono text-[12px] text-faint">{count}</Text>
          </Pressable>
        ))}
      </View>
      <LegendList
        style={{ flex: 1 }}
        data={shown}
        keyExtractor={(session) => session.id}
        estimatedItemSize={60}
        contentContainerStyle={{ paddingBottom: 16 }}
        ListEmptyComponent={
          <Text className="p-5 text-base leading-6 text-faint">
            {stopped ? "No stopped sessions." : "No live sessions."}
          </Text>
        }
        renderItem={({ item }) => (
          <SessionRow
            session={item}
            agent={workspace?.actors.find((a) => a.id === item.actor_id)}
          />
        )}
      />
    </Screen>
  );
}
