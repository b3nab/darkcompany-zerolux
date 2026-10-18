import { useState } from "react";
import { Pressable, View } from "react-native";
import { useRouter } from "expo-router";
import { SquarePenIcon } from "lucide-react-native";
import { useCSSVariable } from "uniwind";
import { LegendList } from "@legendapp/list/react-native";
import {
  attentionInbox,
  attentionLabels,
  consoleSessions,
  sessionOutputAt,
  useSeen,
} from "@zerolux/chat";
import type { Attention } from "@zerolux/chat";
import { Screen } from "@/components/screen";
import { SessionRow } from "@/components/session";
import { Text } from "@/components/ui/text";
import { cn } from "@/lib/utils";
import { useSession } from "../../src/kernel";

/** How each state reads in the inbox: what needs you stands out, the rest stays quiet. */
const attentionTones: Record<Attention, string> = {
  approval: "text-attention",
  input: "text-attention",
  working: "text-agent-foreground",
  failed: "text-destructive",
  unseen: "text-foreground",
  idle: "text-faint",
};

type Shown = "live" | "stopped" | "archived";
const shownLabels: Record<Shown, string> = {
  live: "Live",
  stopped: "Stopped",
  archived: "Archived",
};
const empty: Record<Shown, string> = {
  live: "No live sessions. Start one with the pen above.",
  stopped: "No stopped sessions.",
  archived: "Nothing archived.",
};

/**
 * The Agent Console, as an inbox: the pinned sessions, then each live session in one state,
 * what needs you first, the latest within each; the stopped and archived ones on request.
 * The pen starts a new session, with or without an agent.
 */
export default function Console() {
  const { workspace, chat } = useSession();
  const router = useRouter();
  const ink = String(useCSSVariable("--color-foreground"));
  const [shown, setShown] = useState<Shown>("live");
  const seen = useSeen();
  const sessions = consoleSessions(chat.sessions);
  const rows = attentionInbox(
    sessions[shown].map((session) => ({
      ...session,
      output_at: sessionOutputAt(chat, session) ?? null,
    })),
    chat.approvals,
    seen,
  );
  // The live inbox in sections; the other lists are plain.
  const section = (row: (typeof rows)[number]) =>
    shown !== "live"
      ? undefined
      : row.session.pinned_at
        ? "pinned"
        : row.attention;
  return (
    <Screen
      title="Console"
      action={
        <Pressable
          onPress={() => router.push("/session/new")}
          accessibilityRole="button"
          accessibilityLabel="New session"
          hitSlop={8}
          className="size-10 items-center justify-center rounded-sm active:bg-accent"
        >
          <SquarePenIcon color={ink} size={22} strokeWidth={1.5} />
        </Pressable>
      }
    >
      <View className="mx-5 mb-2 flex-row self-start rounded-sm border border-border bg-sidebar p-0.5">
        {(Object.keys(shownLabels) as Shown[]).map((value) => (
          <Pressable
            key={value}
            onPress={() => setShown(value)}
            accessibilityRole="button"
            accessibilityState={{ selected: shown === value }}
            className={cn(
              "flex-row gap-1.5 rounded-[3px] px-3 py-1.5",
              shown === value && "bg-secondary",
            )}
          >
            <Text
              className={cn(
                "text-[13px] font-medium",
                shown === value ? "text-foreground" : "text-muted-foreground",
              )}
            >
              {shownLabels[value]}
            </Text>
            <Text className="font-mono text-[12px] text-faint">
              {sessions[value].length}
            </Text>
          </Pressable>
        ))}
      </View>
      <LegendList
        style={{ flex: 1 }}
        data={rows}
        keyExtractor={({ session }) => session.id}
        estimatedItemSize={60}
        contentContainerStyle={{ paddingBottom: 16 }}
        ListEmptyComponent={
          <Text className="p-5 text-base leading-6 text-faint">
            {empty[shown]}
          </Text>
        }
        renderItem={({ item, index }) => {
          const { session, attention } = item;
          const here = section(item);
          return (
            <View>
              {here && (index === 0 || section(rows[index - 1]!) !== here) ? (
                <View className="flex-row items-center justify-between px-5 pt-4 pb-1">
                  <Text
                    accessibilityRole="header"
                    className={cn(
                      "font-mono text-[11px] tracking-wider uppercase",
                      here === "pinned" ? "text-faint" : attentionTones[here],
                    )}
                  >
                    {here === "pinned" ? "Pinned" : attentionLabels[here]}
                  </Text>
                  <Text className="font-mono text-[11px] text-faint">
                    {rows.filter((row) => section(row) === here).length}
                  </Text>
                </View>
              ) : null}
              <SessionRow
                session={session}
                agent={workspace?.actors.find((a) => a.id === session.actor_id)}
                attention={attention}
                asks={chat.approvals.find(
                  (a) => a.session_id === session.id && a.status === "pending",
                )}
              />
            </View>
          );
        }}
      />
    </Screen>
  );
}
