import { useState } from "react";
import { Pressable, ScrollView, View } from "react-native";
import { useRouter } from "expo-router";
import {
  activeActors,
  harnessLabels,
  memberTone,
  shiftLabels,
  shiftSegments,
  shiftWindow,
} from "@zerolux/chat";
import type { Actor, MemberTone, ShiftSegment } from "@zerolux/chat";
import { ActorMark } from "@/components/member";
import { Eyebrow } from "@/components/meter";
import { Screen } from "@/components/screen";
import { Text } from "@/components/ui/text";
import { cn } from "@/lib/utils";
import { useSession } from "@/src/kernel";

type Mode = "everyone" | "people" | "agents" | "shift";
const views: Record<Mode, { label: string; note: string }> = {
  everyone: {
    label: "Everyone",
    note: "People report to people. Each person's agents hang off them.",
  },
  people: { label: "People", note: "Who reports to whom." },
  agents: {
    label: "Agents",
    note: "The agent org mirrors the people org: an agent sits where its owner sits.",
  },
  shift: { label: "Shift", note: "Who worked when, over the last 16 hours." },
};
const role = (actor: Actor) =>
  actor.kind === "human"
    ? "Person"
    : actor.harness
      ? harnessLabels[actor.harness]
      : "Agent";

/**
 * The organization: people, and under each of them the agents they own. Agents follow their
 * owners' hierarchy; they have none of their own.
 */
export default function Org() {
  const { workspace, chat } = useSession();
  const router = useRouter();
  const [view, setView] = useState<Mode>("everyone");
  if (!workspace) return <Screen title="Org">{null}</Screen>;
  const actors = activeActors(workspace.actors);
  // TODO: kernel: people report to people; the chart nests them then. Today each person heads a tree.
  const people = actors.filter((a) => a.kind === "human");
  const agentsOf = (person: Actor) =>
    actors.filter((a) => a.owner_id === person.id);
  const tone = (actor: Actor) =>
    memberTone(actor, people[0]?.id, chat.sessions, workspace.connections);
  const open = (actor: Actor) => router.push(`/member/${actor.id}`);
  return (
    <Screen title="Org">
      <View className="px-5 pb-3">
        <View className="flex-row rounded-lg border border-border bg-card p-0.5">
          {(Object.keys(views) as Mode[]).map((id) => (
            <Pressable
              key={id}
              onPress={() => setView(id)}
              accessibilityRole="button"
              accessibilityState={{ selected: view === id }}
              className={cn(
                "h-8 flex-1 items-center justify-center rounded-md",
                view === id && "bg-accent",
              )}
            >
              <Text
                className={cn(
                  "text-xs font-medium",
                  view === id ? "text-foreground" : "text-muted-foreground",
                )}
              >
                {views[id].label}
              </Text>
            </Pressable>
          ))}
        </View>
      </View>
      <ScrollView contentContainerClassName="gap-4 px-5 pb-10">
        <Text className="text-xs text-faint">{views[view].note}</Text>
        {view === "shift" ? (
          <Shift
            rows={people.flatMap((p) => [p, ...agentsOf(p)])}
            open={open}
          />
        ) : (
          people.map((person) =>
            view === "agents" ? (
              <View key={person.id} className="gap-1.5">
                <View className="mb-0.5 flex-row items-center gap-1.5">
                  <ActorMark kind="human" name={person.name} size="sm" />
                  <Text className="text-xs text-faint">
                    {person.name}'s agents
                  </Text>
                </View>
                {agentsOf(person).map((agent) => (
                  <Node key={agent.id} actor={agent} tone={tone} open={open} />
                ))}
                {agentsOf(person).length === 0 && (
                  <Text className="text-xs text-faint">No agents yet.</Text>
                )}
              </View>
            ) : (
              <Node
                key={person.id}
                actor={person}
                agents={view === "everyone" ? agentsOf(person) : []}
                tone={tone}
                open={open}
              />
            ),
          )
        )}
      </ScrollView>
    </Screen>
  );
}

/** One member of the chart; a person's card lists their agents underneath. */
function Node({
  actor,
  agents = [],
  tone,
  open,
}: {
  actor: Actor;
  agents?: Actor[];
  tone: (actor: Actor) => MemberTone;
  open: (actor: Actor) => void;
}) {
  const human = actor.kind === "human";
  return (
    <View
      className={cn(
        "gap-2.5 border border-border p-3",
        human ? "rounded-lg bg-card" : "rounded-xs border-dashed bg-secondary",
      )}
    >
      <Pressable
        onPress={() => open(actor)}
        className="flex-row items-center gap-3"
      >
        <ActorMark kind={actor.kind} name={actor.name} tone={tone(actor)} />
        <View className="flex-1">
          <Text
            className={cn(
              "text-[15px] font-semibold",
              !human && "font-mono font-medium text-agent-foreground",
            )}
          >
            {actor.name}
          </Text>
          <Text className="text-xs text-faint">{role(actor)}</Text>
        </View>
      </Pressable>
      {agents.length > 0 && (
        <View className="flex-row flex-wrap gap-2 border-t border-dashed border-border pt-2.5">
          {agents.map((agent) => (
            <Pressable
              key={agent.id}
              onPress={() => open(agent)}
              className="flex-row items-center gap-1.5 rounded-xs border border-border bg-secondary py-1 pr-2 pl-1 active:bg-accent"
            >
              <ActorMark
                kind="agent"
                name={agent.name}
                tone={tone(agent)}
                size="sm"
              />
              <Text className="font-mono text-xs text-agent-foreground">
                {agent.name}
              </Text>
            </Pressable>
          ))}
        </View>
      )}
    </View>
  );
}

const segmentLook: Record<ShiftSegment["kind"], string> = {
  working: "top-4 h-4 rounded-sm bg-agent",
  waiting: "top-4 h-4 rounded-sm bg-attention",
  online: "top-[23px] h-0.5 rounded-full bg-faint",
};

/** Lanes over the last 16 hours: when each person was online and each agent worked or waited. */
function Shift({
  rows,
  open,
}: {
  rows: Actor[];
  open: (actor: Actor) => void;
}) {
  const shift = shiftWindow();
  const time = (t: number) =>
    new Date(t).toLocaleTimeString(undefined, { hour: "2-digit" });
  const percent = (t: number) => `${shift.at(t) * 100}%` as const;
  return (
    <View className="gap-4">
      <View className="overflow-hidden rounded-lg border border-border bg-card">
        <View className="flex-row border-b border-border">
          <Eyebrow className="w-24 px-3 py-2.5">Last 16 h</Eyebrow>
          <View className="flex-1 flex-row py-2.5">
            {shift.ticks
              .filter((_, i) => i % 2 === 0)
              .map((tick) => (
                <Text
                  key={tick}
                  className="flex-1 border-l border-border pl-1 font-mono text-[10px] text-faint"
                >
                  {time(tick)}
                </Text>
              ))}
          </View>
        </View>
        {rows.map((actor, i) => (
          <View
            key={actor.id}
            className={cn("flex-row", i > 0 && "border-t border-border")}
          >
            <Pressable
              onPress={() => open(actor)}
              className={cn(
                "w-24 flex-row items-center gap-2 py-2 pr-2 active:bg-accent",
                actor.kind === "human" ? "pl-3" : "pl-5",
              )}
            >
              <ActorMark kind={actor.kind} name={actor.name} size="sm" />
              <Text
                numberOfLines={1}
                className={cn(
                  "flex-1 text-xs font-semibold",
                  actor.kind === "agent" &&
                    "font-mono font-medium text-agent-foreground",
                )}
              >
                {actor.name}
              </Text>
            </Pressable>
            <View className="relative h-12 flex-1 flex-row">
              {shift.ticks
                .filter((_, i) => i % 2 === 0)
                .map((tick) => (
                  <View key={tick} className="flex-1 border-l border-border" />
                ))}
              {shiftSegments(actor.id).map((s) => (
                <View
                  key={`${s.kind}:${s.from}`}
                  accessibilityLabel={`${shiftLabels[s.kind]} ${time(s.from)} to ${time(s.to)}`}
                  className={cn("absolute min-w-1", segmentLook[s.kind])}
                  style={{
                    left: percent(s.from),
                    width: `${(shift.at(s.to) - shift.at(s.from)) * 100}%`,
                  }}
                />
              ))}
              <View
                className="absolute top-0 bottom-0 w-px bg-foreground"
                style={{ left: percent(shift.now) }}
              />
            </View>
          </View>
        ))}
      </View>
      <View className="flex-row flex-wrap gap-x-4 gap-y-2">
        {(Object.keys(segmentLook) as ShiftSegment["kind"][]).map((kind) => (
          <View key={kind} className="flex-row items-center gap-2">
            <View
              className={cn(
                "w-5",
                kind === "online" ? "h-0.5 bg-faint" : "h-2 rounded-sm",
                kind === "working" && "bg-agent",
                kind === "waiting" && "bg-attention",
              )}
            />
            <Text className="text-xs text-muted-foreground">
              {shiftLabels[kind]}
            </Text>
          </View>
        ))}
      </View>
    </View>
  );
}
