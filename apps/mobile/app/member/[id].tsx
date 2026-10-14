import { useState } from "react";
import { Alert, Pressable, ScrollView, View } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import {
  activeActors,
  agentPresence,
  agentWork,
  agentSettingFields,
  canApplyAgentSettings,
  agentModelOption,
  useAgentSettings,
  creationDateLabel,
  errorMessage,
  folderName,
  harnessLabels,
  memberTone,
  sessionState,
} from "@zerolux/chat";
import type { Actor, AgentSettings, ChatSession } from "@zerolux/chat";
import { ActorMark, Lamp } from "@/components/member";
import { Eyebrow } from "@/components/meter";
import { Screen } from "@/components/screen";
import { SettingSelect } from "@/components/setting-select";
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
  const tone = (actor: Actor) => memberTone(actor, owner?.id, chat.sessions);
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
          <Text className="text-xs text-faint">
            {creationDateLabel(member)}
          </Text>
          <View className="flex-row items-center gap-2">
            <Lamp kind={member.kind} tone={tone(member)} />
            <Text className="text-xs text-muted-foreground">
              {member.kind === "human"
                ? tone(member) === "on"
                  ? "Online"
                  : "Offline"
                : agentPresence(member.id, chat.sessions).label}
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
  const { chat } = useSession();
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
              {agentPresence(agent.id, chat.sessions).label}
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
  open,
}: {
  agent: Actor;
  owner?: Actor;
  open: (actor: Actor) => void;
}) {
  const { chat } = useSession();
  const router = useRouter();
  const { sessions, earlier, chats, answering, dm, waiting } = agentWork(
    agent,
    chat,
  );
  // With nothing live, its last session stands where the live one would be.
  const current = sessions.length ? sessions : earlier.slice(0, 1);
  const older = earlier.slice(sessions.length ? 0 : 1);
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
          ) : (
            <Text className="text-sm text-faint">Nothing right now</Text>
          )}
        </Row>
        <Row label="Waiting">
          <Text className="font-mono text-xs">
            {waiting} message{waiting === 1 ? "" : "s"}
          </Text>
        </Row>
      </View>
      <AgentSettingsForm key={agent.id} agent={agent} />
      <Sessions
        agent={agent}
        current={current}
        older={older}
        title={
          sessions.length === 0
            ? "Last session"
            : sessions.length === 1
              ? "Session"
              : `Sessions · ${sessions.length}`
        }
      />
      <View className="gap-1">
        <Eyebrow className="mb-1">Chats · {chats.length}</Eyebrow>
        {chats.map((c) => (
          <Pressable
            key={c.id}
            onPress={() => router.push(`/chat/${c.id}`)}
            className="-mx-2 flex-row items-center gap-3 rounded-sm px-2 py-2 active:bg-accent"
          >
            <Text numberOfLines={1} className="flex-1 text-sm">
              {c.kind === "dm" ? "Direct chat" : c.title}
            </Text>
            <Text className="text-xs text-faint">
              {c.members.length} members
            </Text>
          </Pressable>
        ))}
        {chats.length === 0 && (
          <Text className="text-sm text-muted-foreground">
            Not in a chat yet.
          </Text>
        )}
      </View>
      <View className="gap-2">
        <Eyebrow>Budget</Eyebrow>
        {/* TODO: kernel: the agent's monthly spend and budget, from its harness usage. */}
        <Text className="text-sm text-muted-foreground">Not tracked yet.</Text>
      </View>
    </>
  );
}

function AgentSettingsForm({ agent }: { agent: Actor }) {
  const { setAgentSettings, url, chat } = useSession();
  const revision = chat.sessions
    .filter((session) => session.actor_id === agent.id)
    .map((session) => `${session.id}:${session.status}:${session.activity}`)
    .join("|");
  const native = useAgentSettings(agent, revision, url);
  const current = native.data?.actor ?? agent;
  const models = native.data?.models ?? [];
  const [changes, setChanges] = useState<AgentSettings>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const fields = agentSettingFields(
    agent.harness,
    models,
    changes.model ?? current.model,
  );
  const applicable = canApplyAgentSettings(
    changes,
    fields,
    native.data?.editable ?? [],
  );
  async function save() {
    if (busy || native.loading || native.error || !applicable) return;
    setBusy(true);
    setError("");
    try {
      const actor = await setAgentSettings(agent.id, changes);
      native.accept(actor);
      setChanges({});
    } catch (error) {
      setError(errorMessage(error));
    } finally {
      native.refresh();
      setBusy(false);
    }
  }
  return (
    <View className="gap-3 border-b border-border pb-4">
      <Eyebrow>Agent settings</Eyebrow>
      {native.loading && (
        <Text className="text-xs text-muted-foreground">
          Reading native settings…
        </Text>
      )}
      {fields.map(({ key, label, options }) => {
        let value = changes[key] ?? current[key] ?? "";
        if (
          key === "effort" &&
          changes.model !== undefined &&
          !Object.hasOwn(options, value)
        )
          value = "";
        return (
          <SettingSelect
            key={key}
            label={label}
            value={value}
            options={options}
            disabled={
              busy ||
              native.loading ||
              Boolean(native.error) ||
              !native.data?.editable.includes(key) ||
              Object.keys(options).length === 0
            }
            placeholder={
              changes.model && key === "effort" ? "Native choice" : undefined
            }
            onChange={(value) =>
              setChanges((previous) => {
                const next = { ...previous, [key]: value };
                if (
                  key === "model" &&
                  next.effort &&
                  !agentModelOption(models, value)?.efforts.includes(
                    next.effort,
                  )
                )
                  delete next.effort;
                return next;
              })
            }
          />
        );
      })}
      {native.data?.sessions.map(
        (session) =>
          session.error && (
            <Text key={session.id} className="text-xs text-attention">
              {session.error}
            </Text>
          ),
      )}
      {native.data &&
        agent.harness === "codex" &&
        native.data.sessions.length > 0 &&
        !native.data.editable.includes("sandbox") &&
        !native.data.sessions.some((session) => session.error) && (
          <Text className="text-xs text-muted-foreground">
            Codex allows approval and sandbox changes between turns.
          </Text>
        )}
      {native.error && (
        <Text accessibilityRole="alert" className="text-sm text-destructive">
          {native.error}
        </Text>
      )}
      {error ? (
        <Text accessibilityRole="alert" className="text-sm text-destructive">
          {error}
        </Text>
      ) : null}
      <View className="flex-row gap-2">
        <Button
          disabled={
            busy || native.loading || Boolean(native.error) || !applicable
          }
          onPress={() => void save()}
        >
          <Text>{busy ? "Applying…" : "Apply"}</Text>
        </Button>
        {!!Object.keys(changes).length && (
          <Button
            variant="outline"
            disabled={busy}
            onPress={() => {
              setChanges({});
              setError("");
            }}
          >
            <Text>Cancel</Text>
          </Button>
        )}
        <Button
          variant="outline"
          disabled={busy || native.loading}
          onPress={native.refresh}
        >
          <Text>Refresh</Text>
        </Button>
      </View>
    </View>
  );
}

/**
 * Where the agent runs and how, with Stop, Resume and Take over: its live sessions, or the
 * last one, and the earlier ones on request. Stop asks first: it ends the link and cancels
 * a turn only this chat started.
 */
function Sessions({
  agent,
  current,
  older,
  title,
}: {
  agent: Actor;
  current: ChatSession[];
  older: ChatSession[];
  title: string;
}) {
  const { chat } = useSession();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [showOlder, setShowOlder] = useState(false);
  if (current.length === 0) return null;
  const perform = async (action: () => Promise<unknown>) => {
    setBusy(true);
    setError("");
    try {
      await action();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  const confirmStop = (session: ChatSession) =>
    Alert.alert(
      `Stop ${agent.name}?`,
      "It will no longer reply in ZeroLux or resume this session. Your chats and their history stay.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Stop",
          style: "destructive",
          onPress: () => void perform(() => chat.stop(session.id)),
        },
      ],
    );
  // Sessions ZeroLux runs, and pi ones it can continue from their saved file with a
  // verified profile: the kernel refuses what it cannot verify, never picks defaults.
  const resumable = (s: ChatSession) =>
    (s.harness === "pi" || s.origin === "owned") &&
    (s.status === "stopped" || s.status === "attention");
  // A pi hired from a terminal: ZeroLux can take it over while it is idle there.
  const takeable = (s: ChatSession) =>
    s.harness === "pi" && s.origin === "attached" && s.status === "connected";
  const confirmTakeover = (session: ChatSession) =>
    Alert.alert(
      `Take over ${agent.name}?`,
      "The idle terminal closes and the same session continues under ZeroLux: same history, same verified launch profile. Refused if it is working, has queued input or its profile cannot be verified; nothing is killed.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Take over",
          onPress: () => void perform(() => chat.takeoverPi(session.id)),
        },
      ],
    );
  const card = (s: ChatSession, facts: boolean) => {
    const harness = harnessLabels[s.harness] ?? s.harness;
    return (
      <View
        key={s.id}
        className="gap-2 rounded-lg border border-border bg-card p-3"
      >
        <View className="flex-row items-center gap-3">
          <View className="min-w-0 flex-1">
            <Text numberOfLines={1} className="text-sm font-medium">
              {s.title || "Untitled session"}
            </Text>
            <Text numberOfLines={1} className="text-xs text-muted-foreground">
              {facts
                ? sessionState(s)
                : `${harness} · ${folderName(s.workspace)}`}
            </Text>
          </View>
          {takeable(s) ? (
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              onPress={() => confirmTakeover(s)}
            >
              <Text>Take over</Text>
            </Button>
          ) : null}
          {s.status !== "stopped" ? (
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              onPress={() => confirmStop(s)}
            >
              <Text>Stop</Text>
            </Button>
          ) : null}
          {resumable(s) ? (
            <Button
              size="sm"
              disabled={busy}
              onPress={() => void perform(() => chat.resume(s.id))}
            >
              <Text>Resume</Text>
            </Button>
          ) : null}
        </View>
        {facts ? (
          <View>
            <Row label="Harness">
              <Text className="text-sm">{harness}</Text>
            </Row>
            <Row label="Folder">
              <Text className="font-mono text-xs">{s.workspace}</Text>
            </Row>
            <Row label="Started by">
              <Text className="text-sm">
                {s.origin === "owned" ? "ZeroLux" : "You, then hired"}
              </Text>
            </Row>
          </View>
        ) : null}
        {s.attention_reason ? (
          <Text className="text-xs text-attention">{s.attention_reason}</Text>
        ) : null}
      </View>
    );
  };
  return (
    <View className="gap-2">
      <Eyebrow>{title}</Eyebrow>
      {current.map((s) => card(s, true))}
      {older.length > 0 && (
        <Pressable
          onPress={() => setShowOlder(!showOlder)}
          accessibilityRole="button"
          accessibilityState={{ expanded: showOlder }}
          className="py-1.5"
        >
          <Text className="text-sm text-muted-foreground">
            {showOlder ? "Hide" : "Show"} earlier sessions · {older.length}
          </Text>
        </Pressable>
      )}
      {showOlder && older.map((s) => card(s, false))}
      {error ? <Text className="text-sm text-destructive">{error}</Text> : null}
    </View>
  );
}
