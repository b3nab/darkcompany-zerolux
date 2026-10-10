import { Stack, useRouter } from "expo-router";
import { CheckIcon } from "lucide-react-native";
import { useState } from "react";
import { Pressable, ScrollView, View } from "react-native";
import { useCSSVariable } from "uniwind";
import {
  agentsForChat,
  directChat,
  errorMessage,
  harnessLabels,
  liveSessions,
} from "@zerolux/chat";
import type { Conversation } from "@zerolux/chat";
import { ActorMark } from "@/components/member";
import { Screen } from "@/components/screen";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Text } from "@/components/ui/text";
import { cn } from "@/lib/utils";
import { useSession } from "../../src/kernel";

const kinds = { dm: "One agent", group: "Group" } as const;
type Kind = keyof typeof kinds;

/** A new chat, with one agent or a group: each agent through one of its live sessions. */
export default function NewChat() {
  const { chat, actors } = useSession();
  const router = useRouter();
  const [kind, setKind] = useState<Kind>("dm");
  const [picked, setPicked] = useState<string[]>([]);
  const [chosen, setChosen] = useState<Record<string, string>>({});
  const [title, setTitle] = useState("Team");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const onLamp = String(useCSSVariable("--color-primary-foreground"));
  const owner = actors.find((a) => a.kind === "human")?.id;
  const agents = agentsForChat(actors, chat.sessions, picked);
  const members = kind === "dm" ? picked.slice(0, 1) : picked;
  const sessionFor = (actorId: string) => {
    const sessions = liveSessions(chat.sessions, actorId);
    return sessions.find((s) => s.id === chosen[actorId]) ?? sessions[0];
  };
  const ready =
    !!owner &&
    members.length > 0 &&
    members.every((id) => sessionFor(id)) &&
    (kind === "dm" || title.trim().length > 0);

  const pick = (id: string) =>
    setPicked(
      kind === "dm"
        ? [id]
        : picked.includes(id)
          ? picked.filter((p) => p !== id)
          : [...picked, id],
    );

  async function start() {
    if (!ready || !owner) return;
    const open = (c: Conversation) => router.replace(`/chat/${c.id}`);
    const existing =
      kind === "dm" && directChat(chat.conversations, owner, members[0]!);
    if (existing) return open(existing);
    setBusy(true);
    setError("");
    try {
      open(
        await chat.create(
          kind,
          kind === "dm"
            ? (actors.find((a) => a.id === members[0])?.name ?? "Chat")
            : title.trim(),
          members.map((id) => ({
            actor_id: id,
            session_id: sessionFor(id)!.id,
          })),
        ),
      );
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Screen back="close" title="New chat">
      <Stack.Screen options={{ presentation: "modal" }} />
      {agents.length === 0 ? (
        <View className="gap-2 p-5">
          <Text className="text-lg font-semibold">
            Hire an agent to start chatting.
          </Text>
          <Text className="text-sm text-muted-foreground">
            Start a new one here, or hire the sessions you already use from
            ZeroLux on your computer; they appear here.
          </Text>
          <Button
            className="self-start"
            onPress={() => router.replace("/agent/new")}
          >
            <Text>New agent</Text>
          </Button>
        </View>
      ) : (
        <ScrollView
          contentContainerClassName="gap-5 p-5"
          keyboardShouldPersistTaps="handled"
        >
          <View className="flex-row self-start rounded-sm border border-border bg-sidebar p-0.5">
            {(Object.keys(kinds) as Kind[]).map((k) => (
              <Pressable
                key={k}
                onPress={() => {
                  setKind(k);
                  if (k === "dm") setPicked(picked.slice(0, 1));
                }}
                accessibilityRole="button"
                accessibilityState={{ selected: kind === k }}
                className={cn(
                  "rounded-[3px] px-3 py-1.5",
                  kind === k && "bg-secondary",
                )}
              >
                <Text
                  className={cn(
                    "text-[13px] font-medium",
                    kind === k ? "text-foreground" : "text-muted-foreground",
                  )}
                >
                  {kinds[k]}
                </Text>
              </Pressable>
            ))}
          </View>
          {kind === "group" ? (
            <View className="gap-2">
              <Text className="text-sm font-medium">Group name</Text>
              <Input
                value={title}
                onChangeText={setTitle}
                placeholder="Team"
                maxLength={200}
              />
            </View>
          ) : null}
          <View className="gap-2">
            <Text className="text-sm font-medium">
              {kind === "dm" ? "Agent" : "Agents"}
            </Text>
            {agents.map((agent) => {
              const on = members.includes(agent.id);
              const sessions = liveSessions(chat.sessions, agent.id);
              const current = sessionFor(agent.id);
              return (
                <View
                  key={agent.id}
                  className={cn(
                    "gap-2 rounded-sm border p-3",
                    on ? "border-human/50 bg-human/5" : "border-border",
                  )}
                >
                  <Pressable
                    onPress={() => pick(agent.id)}
                    accessibilityRole={kind === "dm" ? "radio" : "checkbox"}
                    accessibilityState={{ checked: on }}
                    className="flex-row items-center gap-3"
                  >
                    <ActorMark kind="agent" name={agent.name} size="sm" />
                    <Text className="flex-1 font-mono text-[15px]">
                      {agent.name}
                    </Text>
                    {agent.harness ? (
                      <Text className="font-mono text-[11px] text-faint">
                        {harnessLabels[agent.harness]}
                      </Text>
                    ) : null}
                    <View
                      className={cn(
                        "size-5 items-center justify-center border",
                        kind === "dm" ? "rounded-full" : "rounded-xs",
                        on ? "border-human bg-human" : "border-input",
                      )}
                    >
                      {on ? (
                        <CheckIcon color={onLamp} size={14} strokeWidth={2.5} />
                      ) : null}
                    </View>
                  </Pressable>
                  {on && !current ? (
                    <Text className="text-xs text-attention">
                      {agent.name} has no live session now.
                    </Text>
                  ) : null}
                  {on && current && sessions.length > 1 ? (
                    <View className="flex-row flex-wrap gap-1.5">
                      {sessions.map((s) => (
                        <Pressable
                          key={s.id}
                          onPress={() =>
                            setChosen({ ...chosen, [agent.id]: s.id })
                          }
                          accessibilityRole="button"
                          accessibilityState={{ selected: s.id === current.id }}
                          className={cn(
                            "rounded-full border px-2.5 py-1",
                            s.id === current.id
                              ? "border-human bg-human/10"
                              : "border-border",
                          )}
                        >
                          <Text className="text-xs" numberOfLines={1}>
                            {s.title}
                          </Text>
                        </Pressable>
                      ))}
                    </View>
                  ) : null}
                </View>
              );
            })}
          </View>
          {error ? (
            <Text className="text-sm text-destructive">{error}</Text>
          ) : null}
          <Button size="lg" disabled={busy || !ready} onPress={start}>
            <Text>{busy ? "Starting…" : "Start chat"}</Text>
          </Button>
        </ScrollView>
      )}
    </Screen>
  );
}
