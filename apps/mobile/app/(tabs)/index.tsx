import { useState } from "react";
import { Pressable, ScrollView, View } from "react-native";
import { useRouter } from "expo-router";
import {
  activeActors,
  ago,
  errorMessage,
  facade,
  greeting,
  homeLabel,
  memberTone,
  needsYou,
  runningNow,
  useMeetings,
  sessionName,
} from "@zerolux/chat";
import type { MemberTone, Place } from "@zerolux/chat";
import { ActorMark } from "@/components/member";
import { McpForm, QuestionForm } from "@/components/request-answer";
import { Eyebrow } from "@/components/meter";
import { Screen } from "@/components/screen";
import { Button } from "@/components/ui/button";
import { Text } from "@/components/ui/text";
import { cn } from "@/lib/utils";
import { useSession } from "@/src/kernel";
import { useMe } from "@/src/me";

/** The chat address of an item, when it belongs to a chat. */
const href = (place: Place) =>
  "chat" in place
    ? (`/chat/${place.chat}` as const)
    : (`/session/${place.session}` as const);

/** The home: what waits for the owner, what runs now, who is in. */
export default function Tonight() {
  const { chat, workspace, capabilities } = useSession();
  const router = useRouter();
  const live = useMeetings(capabilities.includes("meetings-v1")).meetings;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  if (!workspace) return <Screen title={homeLabel()}>{null}</Screen>;
  const actors = activeActors(workspace.actors);
  const actor = (id: string | null) =>
    workspace.actors.find((a) => a.id === id);
  // Who a session works for, or the session itself by its title when it has no agent.
  const who = (actorId: string | null, sessionId: string) => {
    const session = chat.sessions.find((s) => s.id === sessionId);
    return (
      actor(actorId)?.name ??
      (session ? sessionName(session, workspace.actors) : "?")
    );
  };
  const { me } = useMe();
  const needs = needsYou(chat);
  const running = runningNow(chat);
  const tones = actors.map((a) => memberTone(a, me?.id, chat.sessions));
  const people = actors.filter((a) => a.kind === "human").length;
  const working = tones.filter((t) => t === "working").length;
  const now = new Date();

  async function decide(approvalId: string, decision: "allow" | "deny") {
    await act(() => chat.decide(approvalId, decision));
  }
  async function act(operation: () => Promise<void>) {
    setBusy(true);
    try {
      await operation();
      setError("");
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Screen title={homeLabel()}>
      <ScrollView contentContainerClassName="gap-7 px-5 pb-10">
        <View className="gap-2">
          <Eyebrow>
            {now.toLocaleDateString(undefined, {
              weekday: "long",
              day: "numeric",
              month: "long",
            })}{" "}
            ·{" "}
            {now.toLocaleTimeString(undefined, {
              hour: "2-digit",
              minute: "2-digit",
            })}
          </Eyebrow>
          <Text className="text-2xl leading-8 tracking-tight">
            {greeting(now.getHours())}
            {me ? `, ${me.name}` : ""}.{" "}
            <Text className="text-2xl leading-8 text-human-foreground">
              {needs.length === 0
                ? "Nothing needs you."
                : `${needs.length} ${needs.length === 1 ? "thing needs" : "things need"} you.`}
            </Text>
          </Text>
        </View>
        {error ? (
          <Text className="text-sm text-destructive">{error}</Text>
        ) : null}
        {live.map((meeting) => (
          <View
            key={meeting.id}
            className="flex-row items-center gap-3 rounded-md border border-human/30 bg-human/10 p-3.5"
          >
            <View className="flex-1 gap-0.5">
              <Text className="text-sm font-semibold" numberOfLines={1}>
                {meeting.title} is live
              </Text>
              <Text className="text-xs text-muted-foreground" numberOfLines={1}>
                {meeting.participants
                  .map((id) => actor(id)?.name ?? "someone")
                  .join(", ")}{" "}
                · started {ago(meeting.started_at)}
              </Text>
            </View>
            <Button
              size="sm"
              onPress={() => router.push(`/meetings?room=${meeting.id}`)}
            >
              <Text>Join</Text>
            </Button>
          </View>
        ))}
        <View className="gap-2.5">
          <Eyebrow>Needs you · {needs.length}</Eyebrow>
          {needs.length === 0 && (
            <Text className="text-sm text-muted-foreground">
              Nothing is waiting on you. Agents ask here when that changes.
            </Text>
          )}
          {needs.map((need) => {
            const by = actor(need.actorId);
            const to = href(need.place);
            return (
              <Pressable
                key={need.key}
                disabled={!to}
                onPress={() => to && router.push(to)}
                className="gap-3 rounded-md border border-border bg-card p-4 active:bg-accent"
              >
                <View className="flex-row items-center gap-2.5">
                  <ActorMark
                    kind={by?.kind ?? "agent"}
                    name={who(need.actorId, need.sessionId)}
                    size="sm"
                  />
                  <Text className="flex-1 text-xs text-faint" numberOfLines={1}>
                    {[need.kind, need.since && ago(need.since), need.where]
                      .filter(Boolean)
                      .join(" · ")}
                  </Text>
                </View>
                <Text className="text-[15px] font-medium leading-5">
                  {need.title}
                </Text>
                {need.approvalKind && need.approvalKind !== "permission" ? (
                  (() => {
                    const approval = chat.approvals.find(
                      (a) => a.id === need.approvalId,
                    );
                    if (!approval) return null;
                    const Form =
                      approval.kind === "question" ? QuestionForm : McpForm;
                    return (
                      <Form
                        approval={approval}
                        busy={busy}
                        answer={(answer) =>
                          void act(() => chat.answer(approval.id, answer))
                        }
                      />
                    );
                  })()
                ) : need.approvalId ? (
                  <View className="flex-row gap-2">
                    <Button
                      className="flex-1"
                      disabled={busy}
                      onPress={() => void decide(need.approvalId!, "allow")}
                    >
                      <Text>Allow</Text>
                    </Button>
                    <Button
                      className="flex-1"
                      variant="outline"
                      disabled={busy}
                      onPress={() => void decide(need.approvalId!, "deny")}
                    >
                      <Text>Deny</Text>
                    </Button>
                  </View>
                ) : !to ? (
                  <Text className="text-xs text-faint">
                    Open it on the web.
                  </Text>
                ) : null}
              </Pressable>
            );
          })}
        </View>
        <View className="gap-2.5">
          <Eyebrow>Running now · {running.length}</Eyebrow>
          <View className="rounded-md border border-border bg-card">
            {running.length === 0 && (
              <Text className="p-4 text-sm text-muted-foreground">
                No agent is working right now.
              </Text>
            )}
            {running.map((run, i) => {
              const to = href(run.place);
              return (
                <Pressable
                  key={run.key}
                  disabled={!to}
                  onPress={() => to && router.push(to)}
                  className={cn(
                    "flex-row items-center gap-3 px-4 py-3 active:bg-accent",
                    i > 0 && "border-t border-border",
                  )}
                >
                  <ActorMark
                    kind="agent"
                    name={who(run.actorId, run.sessionId)}
                    tone="working"
                    size="sm"
                  />
                  <View className="flex-1">
                    <Text className="font-mono text-sm text-agent-foreground">
                      {who(run.actorId, run.sessionId)}
                    </Text>
                    <Text
                      className="text-sm text-muted-foreground"
                      numberOfLines={1}
                    >
                      {run.what}
                    </Text>
                  </View>
                  <Text className="font-mono text-xs text-faint">
                    {run.since ? ago(run.since) : "now"}
                  </Text>
                </Pressable>
              );
            })}
          </View>
        </View>
        <View className="gap-3 rounded-md border border-border bg-card p-4">
          <Eyebrow>In the building</Eyebrow>
          <Text className="text-[15px] font-semibold">
            {tones.filter((t) => t === "on").length} of {people}{" "}
            {people === 1 ? "person" : "people"} in · {working}{" "}
            {working === 1 ? "agent" : "agents"} working
          </Text>
          <Facade tones={tones} />
          <View className="flex-row flex-wrap gap-x-3.5 gap-y-1.5">
            {legend.map(([label, look]) => (
              <View key={label} className="flex-row items-center gap-1.5">
                <View className={cn("size-2 rounded-xs", look)} />
                <Text className="text-xs text-muted-foreground">{label}</Text>
              </View>
            ))}
          </View>
        </View>
        <View className="gap-2 rounded-md border border-border bg-card p-4">
          <Eyebrow>Agent spend · this month</Eyebrow>
          {/* TODO: kernel: each agent's monthly spend and budget, from its harness usage; one meter per owner here. */}
          <Text className="text-sm text-muted-foreground">
            Spend and budgets are not tracked yet.
          </Text>
        </View>
      </ScrollView>
    </Screen>
  );
}

const windows: Record<MemberTone, string> = {
  on: "bg-human",
  working: "bg-agent",
  connected: "bg-window-dim",
  connecting: "bg-window-dim",
  attention: "bg-destructive",
  stopped: "bg-window-off",
};
const legend = [
  ["person in", windows.on],
  ["agent working", windows.working],
  ["idle", windows.connected],
  ["needs attention", windows.attention],
  ["empty seat", "border border-border bg-window-off"],
] as const;

/** The company as a building at night: one lit window per person in or agent at work. */
function Facade({ tones }: { tones: MemberTone[] }) {
  const cells = facade(tones);
  const rows = Array.from({ length: cells.length / 8 }, (_, r) =>
    cells.slice(r * 8, r * 8 + 8),
  );
  return (
    <View
      role="img"
      aria-label="Who is in"
      className="gap-1.5 rounded-sm border border-border bg-background p-3"
    >
      {rows.map((row, r) => (
        <View key={r} className="flex-row gap-1.5">
          {row.map((tone, i) => (
            <View
              key={i}
              className={cn("flex-1 rounded-xs", windows[tone])}
              style={{ aspectRatio: 3 / 4 }}
            />
          ))}
        </View>
      ))}
    </View>
  );
}
