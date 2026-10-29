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
  ago,
  hitKindLabels,
  matchParts,
  sessionMatches,
  sessionOutputAt,
  startsAnywhere,
  useHistorySearch,
} from "@zerolux/chat";
import type { Attention } from "@zerolux/chat";
import { Screen } from "@/components/screen";
import { WorkspaceButton } from "@/components/workspace-mark";
import { SearchField } from "@/components/search-field";
import { SessionRow } from "@/components/session";
import { Text } from "@/components/ui/text";
import { cn } from "@/lib/utils";
import { useSession } from "../../src/kernel";
import { useMe } from "../../src/me";

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
  live: "No live sessions.",
  stopped: "No stopped sessions.",
  archived: "Nothing archived.",
};

/**
 * The Agent Console, as an inbox: the pinned sessions, then each live session in one state,
 * what needs you first, the latest within each; the stopped and archived ones on request.
 * The pen starts a new session, with or without an agent.
 */
export default function Console() {
  const { workspace, chat, url, hosts } = useSession();
  // Sessions start on the kernel's computer: its person's, or open to you.
  const { me, owner } = useMe();
  const starts = startsAnywhere(hosts.hosts, me?.id, owner);
  const router = useRouter();
  const ink = String(useCSSVariable("--color-foreground"));
  const [shown, setShown] = useState<Shown>("live");
  const [query, setQuery] = useState("");
  const actors = workspace?.actors ?? [];
  // What is typed narrows each list, and its count.
  const sessions = Object.fromEntries(
    Object.entries(consoleSessions(chat.sessions)).map(([list, all]) => [
      list,
      all.filter((session) => sessionMatches(session, actors, query)),
    ]),
  ) as Record<Shown, typeof chat.sessions>;
  const rows = attentionInbox(
    sessions[shown].map((session) => ({
      ...session,
      output_at: sessionOutputAt(chat, session) ?? null,
    })),
    chat.approvals,
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
      leading={<WorkspaceButton />}
      title="Console"
      action={
        starts ? (
          <Pressable
            onPress={() => router.push("/session/new")}
            accessibilityRole="button"
            accessibilityLabel="New session"
            hitSlop={8}
            className="size-10 items-center justify-center rounded-sm active:bg-accent"
          >
            <SquarePenIcon color={ink} size={22} strokeWidth={1.5} />
          </Pressable>
        ) : undefined
      }
    >
      <SearchField
        value={query}
        onChange={setQuery}
        label="Search sessions"
        className="mx-5 mb-2.5"
      />
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
        keyboardDismissMode="on-drag"
        ListFooterComponent={<HistoryResults query={query} kernel={url} />}
        ListEmptyComponent={
          <Text className="p-5 text-base leading-6 text-faint">
            {query.trim()
              ? `No ${shownLabels[shown].toLowerCase()} session matches "${query.trim()}".`
              : empty[shown]}
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
                agent={actors.find((a) => a.id === session.actor_id)}
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

/**
 * Under the sessions that match, what the sessions you may read said and did that contains the
 * words typed, the latest first; a tap opens the session at that place.
 */
function HistoryResults({ query, kernel }: { query: string; kernel: string }) {
  const router = useRouter();
  const { results, truncated, error, searching } = useHistorySearch(
    query,
    kernel,
  );
  if (query.trim().length < 2) return null;
  return (
    <View className="gap-1 pt-4">
      <Text className="px-5 pb-1 font-mono text-[11px] tracking-wider text-faint uppercase">
        In their history
      </Text>
      {error ? (
        <Text className="px-5 text-sm text-destructive">{error}</Text>
      ) : searching && !results ? (
        <Text className="px-5 text-sm text-faint">Searching…</Text>
      ) : results && !results.length ? (
        <Text className="px-5 text-sm text-faint">No matches.</Text>
      ) : null}
      {results?.map((hit) => (
        <Pressable
          key={`${hit.session_id}:${hit.at}:${hit.kind}`}
          accessibilityRole="button"
          onPress={() =>
            router.push({
              pathname: "/session/[id]",
              params: { id: hit.session_id, at: String(hit.at) },
            })
          }
          className="gap-0.5 px-5 py-2 active:bg-accent"
        >
          <View className="flex-row items-baseline gap-2">
            <Text numberOfLines={1} className="shrink text-sm font-medium">
              {hit.title || "Untitled session"}
            </Text>
            <Text className="font-mono text-[11px] text-faint">
              {hitKindLabels[hit.kind]}
            </Text>
            {hit.time ? (
              <Text className="ml-auto font-mono text-[11px] text-faint">
                {ago(Date.parse(hit.time))}
              </Text>
            ) : null}
          </View>
          <Text numberOfLines={2} className="text-[13px] text-muted-foreground">
            {matchParts(hit.snippet, query).map((part, i) =>
              part.match ? (
                <Text key={i} className="bg-primary/25 text-foreground">
                  {part.text}
                </Text>
              ) : (
                part.text
              ),
            )}
          </Text>
        </Pressable>
      ))}
      {truncated ? (
        <Text className="px-5 pt-1 text-xs text-faint">
          Some sessions were not searched.
        </Text>
      ) : null}
    </View>
  );
}
