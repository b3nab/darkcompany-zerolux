import { useEffect, useState } from "react";
import { Pressable, ScrollView, TextInput, View } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { VideoView } from "@livekit/react-native";
import {
  AudioLinesIcon,
  HandIcon,
  MicIcon,
  MicOffIcon,
  PhoneOffIcon,
  VideoIcon,
  VideoOffIcon,
} from "lucide-react-native";
import type { LucideIcon } from "lucide-react-native";
import { useCSSVariable } from "uniwind";
import {
  activeActors,
  ago,
  errorMessage,
  liveSessions,
  useMeetings,
  useRoom,
} from "@zerolux/chat";
import type { Actor, Meetings as MeetingList, Seat } from "@zerolux/chat";
import { ActorMark } from "@/components/member";
import { Eyebrow } from "@/components/meter";
import { Screen } from "@/components/screen";
import { Button } from "@/components/ui/button";
import { Text } from "@/components/ui/text";
import { cn } from "@/lib/utils";
import { useSession } from "@/src/kernel";

/** Meetings on LiveKit: start one or join a live one, then the room itself. */
export default function Meetings() {
  const { workspace, chat, capabilities } = useSession();
  const router = useRouter();
  const params = useLocalSearchParams<{ room?: string; chat?: string }>();
  const ready = capabilities.includes("meetings-v1");
  const meetings = useMeetings(ready);
  const roomId = (ready && params.room) || undefined;
  const actor = (id: string) => workspace?.actors.find((a) => a.id === id);
  const enter = (id: string) => router.setParams({ room: id });
  if (!roomId)
    return (
      <Lobby
        // A chat's Meet opens the lobby for that chat: its meeting belongs to it.
        from={chat.conversations.find((c) => c.id === params.chat)}
        ready={ready}
        meetings={meetings}
        actor={actor}
        enter={enter}
      />
    );
  return (
    <Room
      meetingId={roomId}
      meetings={meetings}
      agents={activeActors(workspace?.actors ?? []).filter(
        (a) => a.kind === "agent" && liveSessions(chat.sessions, a.id).length,
      )}
      actor={actor}
      leave={() => router.replace("/meetings")}
    />
  );
}

function Lobby({
  from,
  ready,
  meetings,
  actor,
  enter,
}: {
  from?: { id: string; title: string };
  ready: boolean;
  meetings: MeetingList;
  actor: (id: string) => Actor | undefined;
  enter: (id: string) => void;
}) {
  const { workspace } = useSession();
  const owner = workspace?.actors.find((a) => a.kind === "human");
  const [title, setTitle] = useState(from?.title ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function start() {
    setBusy(true);
    try {
      const meeting = await meetings.start(
        title.trim() || from?.title || `${owner?.name ?? "Your"}'s meeting`,
        from?.id ?? null,
      );
      enter(meeting.id);
    } catch (e) {
      setError(errorMessage(e));
      setBusy(false);
    }
  }
  return (
    <Screen back title="Meetings" subtitle={from && `For ${from.title}`}>
      <ScrollView contentContainerClassName="gap-6 px-5 py-5">
        <View className="gap-2">
          <TextInput
            value={title}
            onChangeText={setTitle}
            editable={ready}
            placeholder="Weekly sync"
            accessibilityLabel="Meeting title"
            maxLength={200}
            className="h-11 rounded-md border border-input bg-background px-3 text-base text-foreground placeholder:text-muted-foreground"
          />
          <Button disabled={!ready || busy} onPress={() => void start()}>
            <Text>Start a meeting</Text>
          </Button>
        </View>
        {error || meetings.error ? (
          <Text className="text-sm text-destructive">
            {error || meetings.error}
          </Text>
        ) : null}
        <View className="gap-2.5">
          <Eyebrow>Live now · {meetings.meetings.length}</Eyebrow>
          {meetings.meetings.map((meeting) => (
            <View
              key={meeting.id}
              className="flex-row items-center gap-3 rounded-md border border-human/30 bg-human/10 p-3.5"
            >
              <View className="flex-1 gap-0.5">
                <Text className="text-sm font-semibold" numberOfLines={1}>
                  {meeting.title}
                </Text>
                <Text
                  className="text-xs text-muted-foreground"
                  numberOfLines={1}
                >
                  {meeting.participants
                    .map((id) => actor(id)?.name ?? "someone")
                    .join(", ")}{" "}
                  · started {ago(meeting.started_at)}
                </Text>
              </View>
              <Button size="sm" onPress={() => enter(meeting.id)}>
                <Text>Join</Text>
              </Button>
            </View>
          ))}
          {meetings.meetings.length === 0 && (
            <Text className="text-sm text-muted-foreground">
              {ready
                ? "No meeting right now."
                : "This kernel has no meeting rooms yet."}
            </Text>
          )}
        </View>
      </ScrollView>
    </Screen>
  );
}

function Room({
  meetingId,
  meetings,
  agents,
  actor,
  leave,
}: {
  meetingId: string;
  meetings: MeetingList;
  agents: Actor[];
  actor: (id: string) => Actor | undefined;
  leave: () => void;
}) {
  const room = useRoom(meetingId, meetings.join);
  const meeting = meetings.meetings.find((m) => m.id === meetingId);
  const [inviting, setInviting] = useState(false);
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const inRoom = new Set(room.seats.map((s) => s.actorId));
  const invitable = agents.filter((a) => !inRoom.has(a.id));
  return (
    <Screen
      back
      title={meeting?.title ?? "Meeting"}
      subtitle={`${meeting ? `${duration(now - meeting.started_at)} · ` : ""}${room.seats.length} in the room`}
    >
      <ScrollView contentContainerClassName="gap-4 px-4 py-4">
        {room.error || meetings.error ? (
          <Text className="text-sm text-destructive">
            {room.error || meetings.error}
          </Text>
        ) : null}
        {!room.live && !room.error && (
          <Text className="text-center text-sm text-muted-foreground">
            Joining…
          </Text>
        )}
        <View className="flex-row flex-wrap gap-2.5">
          {room.seats.map((seat) => (
            <Tile key={seat.identity} seat={seat} actor={actor(seat.actorId)} />
          ))}
        </View>
        <View className="flex-row flex-wrap items-center justify-center gap-2.5">
          <Control
            icon={room.microphone ? MicIcon : MicOffIcon}
            label={room.microphone ? "Mute" : "Unmute"}
            danger={!room.microphone}
            disabled={!room.live}
            onPress={() => void room.setMicrophone(!room.microphone)}
          />
          <Control
            icon={room.camera ? VideoIcon : VideoOffIcon}
            label={room.camera ? "Turn the camera off" : "Turn the camera on"}
            active={room.camera}
            disabled={!room.live}
            onPress={() => void room.setCamera(!room.camera)}
          />
          <Control
            icon={HandIcon}
            label="Raise your hand"
            active={room.hand}
            disabled={!room.live}
            onPress={() => void room.setHand(!room.hand)}
          />
          <Control
            icon={AudioLinesIcon}
            label="Invite an agent"
            active={inviting}
            disabled={!room.live}
            onPress={() => setInviting(!inviting)}
          />
          <Control icon={PhoneOffIcon} label="Leave" danger onPress={leave} />
        </View>
        {inviting && (
          <View className="gap-1 rounded-md border border-agent/30 bg-agent/10 p-3">
            <Text className="text-xs text-muted-foreground">
              Agents join with their owner's place in the company: they listen,
              answer and create tasks.
            </Text>
            {invitable.map((agent) => (
              <Pressable
                key={agent.id}
                onPress={() => void meetings.invite(meetingId, agent.id)}
                className="flex-row items-center gap-2.5 rounded-sm py-2 active:bg-accent"
              >
                <ActorMark kind="agent" name={agent.name} size="sm" />
                <Text className="font-mono text-sm text-agent-foreground">
                  {agent.name}
                </Text>
              </Pressable>
            ))}
            {invitable.length === 0 && (
              <Text className="py-1 text-sm">No other agent is connected.</Text>
            )}
          </View>
        )}
        <View className="gap-2 rounded-md border border-border bg-card p-4">
          <Eyebrow>Transcript</Eyebrow>
          {/* TODO: kernel: the room's live transcript, each line with its speaker, and what agents do during the call. */}
          <Text className="text-sm text-muted-foreground">
            No transcript yet.
          </Text>
        </View>
      </ScrollView>
    </Screen>
  );
}

/** One person or agent: their camera or screen, else their mark, lit while speaking. */
function Tile({ seat, actor }: { seat: Seat; actor?: Actor }) {
  const human = actor?.kind === "human";
  const [muted, hand] = useCSSVariable([
    "--color-destructive",
    "--color-primary-foreground",
  ]);
  const video = seat.screen ?? seat.camera;
  return (
    <View
      className={cn(
        "overflow-hidden border bg-card",
        human ? "rounded-xl" : "rounded-sm",
        seat.speaking
          ? human
            ? "border-human"
            : "border-agent"
          : "border-border",
      )}
      style={{ width: "48.5%", aspectRatio: 3 / 4 }}
    >
      {video ? (
        <VideoView
          videoTrack={video}
          objectFit="cover"
          // People see themselves as in a mirror; a shared screen reads as it is.
          mirror={seat.local && !seat.screen}
          style={{ flex: 1 }}
        />
      ) : (
        <View className="flex-1 items-center justify-center">
          <ActorMark
            kind={human ? "human" : "agent"}
            name={actor?.name ?? "?"}
            size="lg"
          />
        </View>
      )}
      {seat.hand && (
        <View className="absolute top-2 right-2 size-7 items-center justify-center rounded-full bg-human">
          <HandIcon color={String(hand)} size={14} />
        </View>
      )}
      <View className="absolute bottom-2 left-2 max-w-[90%] flex-row items-center gap-1.5 rounded-sm bg-background/70 px-2 py-1">
        {!seat.microphone && <MicOffIcon color={String(muted)} size={12} />}
        <Text
          numberOfLines={1}
          className={cn(
            "text-xs font-medium",
            !human && "font-mono text-agent-foreground",
          )}
        >
          {actor?.name ?? "Guest"}
          {seat.local ? " · you" : ""}
        </Text>
      </View>
    </View>
  );
}

function Control({
  icon: Icon,
  label,
  active,
  danger,
  disabled,
  onPress,
}: {
  icon: LucideIcon;
  label: string;
  active?: boolean;
  danger?: boolean;
  disabled?: boolean;
  onPress: () => void;
}) {
  const [ink, alarm] = useCSSVariable([
    "--color-foreground",
    "--color-destructive-foreground",
  ]);
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ selected: active, disabled }}
      className={cn(
        "size-12 items-center justify-center rounded-full",
        danger ? "bg-destructive" : active ? "bg-accent" : "bg-secondary",
        disabled && "opacity-50",
      )}
    >
      <Icon color={String(danger ? alarm : ink)} size={20} strokeWidth={1.5} />
    </Pressable>
  );
}

const duration = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  const pad = (n: number) => String(n).padStart(2, "0");
  const hours = Math.floor(s / 3600);
  return `${hours ? `${hours}:` : ""}${pad(Math.floor(s / 60) % 60)}:${pad(s % 60)}`;
};
