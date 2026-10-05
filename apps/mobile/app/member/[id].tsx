import { Pressable, ScrollView, View } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import {
  activeActors,
  agentPresence,
  agentWork,
  harnessLabels,
  memberTone,
} from "@zerolux/chat";
import type { Actor, Workspace } from "@zerolux/chat";
import { ActorMark, Lamp } from "@/components/member";
import { Eyebrow } from "@/components/meter";
import { Screen } from "@/components/screen";
import { Button } from "@/components/ui/button";
import { Text } from "@/components/ui/text";
import { cn } from "@/lib/utils";
import { useSession } from "@/src/kernel";

const role = (actor: Actor) =>
  actor.kind === "human"
    ? "Person"
    : actor.harness
      ? harnessLabels[actor.harness]
      : "Agent";

/** A member's profile: a person and their agents, or an agent and what it does. */
export default function Member() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { workspace, chat } = useSession();
  const router = useRouter();
  const member = workspace?.actors.find((a) => a.id === id);
  if (!workspace || !member)
    return (
      <Screen back title="Member">
        {null}
      </Screen>
    );
  const actors = activeActors(workspace.actors);
  const owner = actors.find((a) => a.kind === "human");
  const tone = (actor: Actor) =>
    memberTone(actor, owner?.id, chat.sessions, workspace.connections);
  const open = (actor: Actor) => router.push(`/member/${actor.id}`);
  const isOwner = member.id === owner?.id;
  return (
    <Screen
      back
      title={member.name}
      subtitle={isOwner ? "Owner" : role(member)}
    >
      <ScrollView contentContainerClassName="gap-6 px-5 py-6">
        <View className="items-start gap-3">
          <ActorMark
            kind={member.kind}
            name={member.name}
            tone={tone(member)}
            size="lg"
          />
          <Text
            className={cn(
              "text-xl font-medium tracking-tight",
              member.kind === "agent" && "font-mono text-agent-foreground",
            )}
          >
            {member.name}
          </Text>
          <View className="flex-row items-center gap-2">
            <Lamp kind={member.kind} tone={tone(member)} />
            <Text className="text-xs text-muted-foreground">
              {member.kind === "human"
                ? tone(member) === "on"
                  ? "Online"
                  : "Offline"
                : agentPresence(member.id, chat.sessions, workspace.connections)
                    .label}
            </Text>
          </View>
        </View>
        {member.kind === "human" ? (
          <Person
            person={member}
            agents={actors.filter((a) => a.owner_id === member.id)}
            tone={tone}
            open={open}
          />
        ) : (
          <Agent
            agent={member}
            owner={actors.find((a) => a.id === member.owner_id)}
            workspace={workspace}
            open={open}
          />
        )}
      </ScrollView>
    </Screen>
  );
}

function Row({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <View className="flex-row items-center gap-3 py-1.5">
      <Text className="w-24 text-sm text-faint">{label}</Text>
      <View className="min-w-0 flex-1">{children}</View>
    </View>
  );
}

function Person({
  person,
  agents,
  tone,
  open,
}: {
  person: Actor;
  agents: Actor[];
  tone: (actor: Actor) => ReturnType<typeof memberTone>;
  open: (actor: Actor) => void;
}) {
  const { chat, workspace } = useSession();
  const first = person.name.split(" ")[0];
  return (
    <>
      <View className="border-y border-border py-2">
        {/* TODO: kernel: people report to people; show who this person reports to. */}
        <Row label="Reports to">
          <Text className="text-sm text-faint">No one</Text>
        </Row>
        <Row label="Agents">
          <Text className="font-mono text-sm">{agents.length}</Text>
        </Row>
      </View>
      <View className="gap-1">
        <Eyebrow className="mb-1">Agents · {agents.length}</Eyebrow>
        {agents.map((agent) => (
          <Pressable
            key={agent.id}
            onPress={() => open(agent)}
            className="-mx-2 flex-row items-center gap-3 rounded-sm px-2 py-2 active:bg-accent"
          >
            <ActorMark
              kind="agent"
              name={agent.name}
              tone={tone(agent)}
              size="sm"
            />
            <Text className="flex-1 font-mono text-sm text-agent-foreground">
              {agent.name}
            </Text>
            <Text className="text-xs text-faint">
              {
                agentPresence(
                  agent.id,
                  chat.sessions,
                  workspace?.connections ?? [],
                ).label
              }
            </Text>
          </Pressable>
        ))}
        {agents.length === 0 && (
          <Text className="text-sm text-muted-foreground">No agents yet.</Text>
        )}
        {/* TODO: kernel: each agent's monthly spend against its budget, one meter per agent here. */}
        <Text className="mt-2 text-xs text-muted-foreground">
          {first}'s agents sit where {first} sits in the organization.
        </Text>
      </View>
    </>
  );
}

function Agent({
  agent,
  owner,
  workspace,
  open,
}: {
  agent: Actor;
  owner?: Actor;
  workspace: Workspace;
  open: (actor: Actor) => void;
}) {
  const { chat } = useSession();
  const router = useRouter();
  const { sessions, answering, task, dm, waiting } = agentWork(
    agent,
    workspace,
    chat,
  );
  return (
    <>
      {dm && (
        <Button onPress={() => router.push(`/chat/${dm.id}`)}>
          <Text>Message {agent.name}</Text>
        </Button>
      )}
      <View className="border-y border-border py-2">
        <Row label="Owned by">
          {owner ? (
            <Pressable
              onPress={() => open(owner)}
              className="flex-row items-center gap-2"
            >
              <ActorMark kind="human" name={owner.name} size="sm" />
              <Text className="text-sm font-medium text-human-foreground">
                {owner.name}
              </Text>
            </Pressable>
          ) : (
            <Text className="text-sm text-faint">No one</Text>
          )}
        </Row>
        <Row label="Working on">
          {answering ? (
            <Pressable onPress={() => router.push(`/chat/${answering.id}`)}>
              <Text numberOfLines={1} className="text-sm">
                Answering in {answering.title}
              </Text>
            </Pressable>
          ) : task ? (
            <Text numberOfLines={1} className="text-sm">
              {task.title}
            </Text>
          ) : (
            <Text className="text-sm text-faint">Nothing right now</Text>
          )}
        </Row>
        <Row label="Runtime">
          <Text className="font-mono text-xs">
            {agent.harness ?? "custom"} · {sessions.length} live session
            {sessions.length === 1 ? "" : "s"}
          </Text>
        </Row>
        <Row label="Waiting">
          <Text className="font-mono text-xs">
            {waiting} message{waiting === 1 ? "" : "s"}
          </Text>
        </Row>
      </View>
      <View className="gap-2">
        <Eyebrow>Budget</Eyebrow>
        {/* TODO: kernel: the agent's monthly spend and budget, from its harness usage. */}
        <Text className="text-sm text-muted-foreground">Not tracked yet.</Text>
      </View>
    </>
  );
}
