import { useEffect, useRef, useState } from "react";
import type { SubmitEvent } from "react";
import { useSearchParams } from "react-router";
import { cn } from "cn";
import {
  AudioLinesIcon,
  CaptionsIcon,
  HandIcon,
  MicIcon,
  MicOffIcon,
  PhoneIcon,
  PhoneOffIcon,
  ScreenShareIcon,
  VideoIcon,
  VideoOffIcon,
} from "lucide-react";
import {
  ago,
  errorMessage,
  liveSessions,
  useMeetings,
  useRoom,
} from "@zerolux/chat";
import type {
  Chat,
  Conversation,
  Meeting,
  Meetings as MeetingList,
  Seat,
  Track,
} from "@zerolux/chat";
import { activeActors } from "./api";
import type { Actor, Workspace } from "./api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Page } from "@/components/page";
import { ActorMark, Eyebrow } from "@/components/presence";

/** Meetings on LiveKit: start one or join a live one, then the room itself. */
export function Meetings({
  workspace,
  chat,
  owner,
  capabilities,
}: {
  workspace: Workspace;
  chat: Chat;
  owner: Actor;
  capabilities: string[];
}) {
  const ready = capabilities.includes("meetings-v1");
  const meetings = useMeetings(ready);
  // The address names the room this client is in; leaving clears it.
  const [params, setParams] = useSearchParams();
  const roomId = (ready && params.get("room")) || undefined;
  const actor = (id: string) => workspace.actors.find((a) => a.id === id);
  const enter = (id?: string) => setParams(id ? { room: id } : {});
  if (!roomId)
    return (
      <Lobby
        // A chat's Meet opens the lobby for that chat: its meeting belongs to it.
        from={chat.conversations.find((c) => c.id === params.get("chat"))}
        ready={ready}
        meetings={meetings}
        owner={owner}
        actor={actor}
        enter={enter}
      />
    );
  return (
    <Room
      meetingId={roomId}
      meeting={meetings.meetings.find((m) => m.id === roomId)}
      meetings={meetings}
      agents={activeActors(workspace.actors).filter(
        (a) => a.kind === "agent" && liveSessions(chat.sessions, a.id).length,
      )}
      actor={actor}
      leave={() => enter()}
    />
  );
}

function Lobby({
  from,
  ready,
  meetings,
  owner,
  actor,
  enter,
}: {
  from?: Conversation;
  ready: boolean;
  meetings: MeetingList;
  owner: Actor;
  actor: (id: string) => Actor | undefined;
  enter: (id: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function start(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    const title = String(new FormData(event.currentTarget).get("title"));
    setBusy(true);
    try {
      const meeting = await meetings.start(
        title.trim() || from?.title || `${owner.name}'s meeting`,
        from?.id ?? null,
      );
      enter(meeting.id);
    } catch (e) {
      setError(errorMessage(e));
      setBusy(false);
    }
  }
  return (
    <Page className="max-w-180">
      {from && <Eyebrow>A meeting for {from.title}</Eyebrow>}
      <form onSubmit={(e) => void start(e)} className="flex flex-wrap gap-2">
        <Input
          key={from?.id}
          name="title"
          aria-label="Meeting title"
          defaultValue={from?.title}
          placeholder="Weekly sync"
          maxLength={200}
          disabled={!ready}
          className="min-w-48 flex-1"
        />
        <Button type="submit" disabled={!ready || busy}>
          <PhoneIcon />
          Start a meeting
        </Button>
      </form>
      {(error || meetings.error) && (
        <p
          role="alert"
          className="rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
        >
          {error || meetings.error}
        </p>
      )}
      <section className="flex flex-col gap-2.5">
        <Eyebrow>Live now · {meetings.meetings.length}</Eyebrow>
        {meetings.meetings.map((meeting) => (
          <div
            key={meeting.id}
            className="flex items-center gap-3.5 rounded-md border border-human/30 bg-human/10 px-3.5 py-3"
          >
            <Faces ids={meeting.participants} actor={actor} />
            <div className="flex min-w-0 flex-1 flex-col gap-0.5">
              <strong className="truncate text-sm font-semibold">
                {meeting.title}
              </strong>
              <span className="truncate text-xs text-muted-foreground">
                {meeting.participants.length} in the room · started{" "}
                {ago(meeting.started_at)}
              </span>
            </div>
            <Button size="sm" onClick={() => enter(meeting.id)}>
              <PhoneIcon />
              Join
            </Button>
          </div>
        ))}
        {meetings.meetings.length === 0 && (
          <p className="text-sm text-muted-foreground">
            {ready
              ? "No meeting right now."
              : "This kernel has no meeting rooms yet."}
          </p>
        )}
      </section>
    </Page>
  );
}

function Room({
  meetingId,
  meeting,
  meetings,
  agents,
  actor,
  leave,
}: {
  meetingId: string;
  meeting?: Meeting;
  meetings: MeetingList;
  agents: Actor[];
  actor: (id: string) => Actor | undefined;
  leave: () => void;
}) {
  const room = useRoom(meetingId, meetings.join);
  const [transcript, setTranscript] = useState(true);
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const inRoom = new Set(room.seats.map((s) => s.actorId));
  const invitable = agents.filter((a) => !inRoom.has(a.id));
  const control = "size-10 rounded-full [&_svg:not([class*='size-'])]:size-4.5";
  return (
    <div
      className={cn(
        "grid min-h-0 flex-1 bg-background",
        transcript && "lg:grid-cols-[minmax(0,1fr)_21rem]",
      )}
    >
      <section
        aria-label={meeting?.title ?? "Meeting"}
        className="flex min-h-0 min-w-0 flex-col px-5 pt-4 pb-4.5"
      >
        <header className="mb-4 flex flex-wrap items-center gap-2.5">
          <span className="rounded-xs bg-destructive px-1.5 py-0.5 font-mono text-[10px] font-medium tracking-wider text-background uppercase">
            Live
          </span>
          <strong className="text-[15px] font-semibold">
            {meeting?.title ?? "Meeting"}
          </strong>
          <span className="font-mono text-xs text-faint">
            {meeting && `${duration(now - meeting.started_at)} · `}
            {room.seats.length} in the room · LiveKit
          </span>
          <span className="flex-1" />
          <Faces ids={room.seats.map((s) => s.actorId)} actor={actor} />
        </header>
        {(room.error || meetings.error) && (
          <p
            role="alert"
            className="mb-3 rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
          >
            {room.error || meetings.error}
          </p>
        )}
        {room.muted && (
          <Button
            variant="outline"
            className="mb-3 self-center"
            onClick={() => void room.startAudio()}
          >
            Turn on the sound
          </Button>
        )}
        <div
          className={cn(
            "grid min-h-0 flex-1 content-center gap-2.5 sm:grid-cols-2",
            room.seats.length > 4 && "lg:grid-cols-3",
          )}
        >
          {!room.live && !room.error && (
            <p className="col-span-full text-center text-sm text-muted-foreground">
              Joining…
            </p>
          )}
          {room.seats.map((seat) => (
            <Tile key={seat.identity} seat={seat} actor={actor(seat.actorId)} />
          ))}
        </div>
        <div className="mt-4 flex flex-wrap items-center justify-center gap-2">
          <Button
            variant={room.microphone ? "secondary" : "destructive"}
            className={control}
            aria-label={room.microphone ? "Mute" : "Unmute"}
            disabled={!room.live}
            onClick={() => void room.setMicrophone(!room.microphone)}
          >
            {room.microphone ? <MicIcon /> : <MicOffIcon />}
          </Button>
          <Button
            variant="secondary"
            className={control}
            aria-label={
              room.camera ? "Turn the camera off" : "Turn the camera on"
            }
            aria-pressed={room.camera}
            disabled={!room.live}
            onClick={() => void room.setCamera(!room.camera)}
          >
            {room.camera ? <VideoIcon /> : <VideoOffIcon />}
          </Button>
          <Button
            variant="secondary"
            className={cn(control, room.screen && "bg-primary/20")}
            aria-label="Share the screen"
            aria-pressed={room.screen}
            disabled={!room.live}
            onClick={() => void room.setScreen(!room.screen)}
          >
            <ScreenShareIcon />
          </Button>
          <Button
            variant="secondary"
            className={cn(
              control,
              room.hand && "bg-human/20 text-human-foreground",
            )}
            aria-label="Raise your hand"
            aria-pressed={room.hand}
            disabled={!room.live}
            onClick={() => void room.setHand(!room.hand)}
          >
            <HandIcon />
          </Button>
          <Button
            variant="secondary"
            className={cn(control, transcript && "bg-accent")}
            aria-label="Transcript"
            aria-pressed={transcript}
            onClick={() => setTranscript(!transcript)}
          >
            <CaptionsIcon />
          </Button>
          <span aria-hidden className="mx-1 h-5.5 w-px bg-border" />
          <Popover>
            <PopoverTrigger
              render={
                <Button
                  size="lg"
                  disabled={!room.live}
                  className="border-agent/30 bg-agent/10 text-agent-foreground hover:bg-agent/20"
                />
              }
            >
              <AudioLinesIcon />
              Invite agent
            </PopoverTrigger>
            <PopoverContent side="top">
              <p className="px-1 text-xs text-muted-foreground">
                Agents join with their owner's place in the company: they
                listen, answer and create tasks.
              </p>
              {invitable.map((agent) => (
                <button
                  key={agent.id}
                  type="button"
                  onClick={() => void meetings.invite(meetingId, agent.id)}
                  className="flex items-center gap-2.5 rounded-sm px-1 py-1.5 text-left transition-colors hover:bg-accent"
                >
                  <ActorMark
                    kind="agent"
                    name={agent.name}
                    className="size-7"
                  />
                  <span className="font-mono text-sm text-agent-foreground">
                    {agent.name}
                  </span>
                </button>
              ))}
              {invitable.length === 0 && (
                <p className="px-1 text-sm">No other agent is connected.</p>
              )}
            </PopoverContent>
          </Popover>
          <span aria-hidden className="mx-1 h-5.5 w-px bg-border" />
          <Button variant="destructive" size="lg" onClick={leave}>
            <PhoneOffIcon />
            Leave
          </Button>
        </div>
        {room.seats
          .filter((s) => s.audio)
          .map((s) => (
            <Media key={s.identity} track={s.audio!} kind="audio" />
          ))}
      </section>
      {transcript && (
        <aside
          aria-label="Transcript"
          className="flex min-h-0 flex-col border-t bg-card lg:border-t-0 lg:border-l"
        >
          <header className="flex items-center gap-2 border-b px-4 py-3.5">
            <CaptionsIcon className="size-4 text-faint" />
            <h2 className="flex-1 font-semibold">Transcript</h2>
          </header>
          {/* TODO: kernel: the room's live transcript, each line with its speaker, and what agents do during the call. */}
          <p className="p-4 text-sm text-muted-foreground">
            No transcript yet.
          </p>
        </aside>
      )}
    </div>
  );
}

/** One person or agent on the stage: their video or screen, else their mark, lit while speaking. */
function Tile({ seat, actor }: { seat: Seat; actor?: Actor }) {
  const human = actor?.kind === "human";
  const video = seat.screen ?? seat.camera;
  return (
    <div
      className={cn(
        "relative aspect-[16/10] min-w-0 overflow-hidden border bg-card transition-shadow",
        human ? "rounded-xl" : "rounded-sm",
        seat.speaking &&
          (human
            ? "border-human shadow-[0_0_32px_-6px_var(--color-human)] ring-1 ring-human"
            : "border-agent shadow-[0_0_32px_-6px_var(--color-agent)] ring-1 ring-agent"),
      )}
    >
      {video ? (
        <Media
          track={video}
          kind="video"
          // People see themselves as in a mirror; a shared screen reads as it is.
          className={cn(seat.local && !seat.screen && "-scale-x-100")}
        />
      ) : (
        <div className="absolute inset-0 grid place-items-center">
          <ActorMark
            kind={human ? "human" : "agent"}
            name={actor?.name ?? "?"}
            className="size-18 text-2xl"
          />
        </div>
      )}
      {seat.hand && (
        <span
          aria-label="Hand raised"
          className="absolute top-2.5 right-2.5 grid size-7 place-items-center rounded-full bg-human text-background"
        >
          <HandIcon className="size-3.5" />
        </span>
      )}
      <span className="absolute bottom-2.5 left-2.5 flex h-6.5 max-w-[calc(100%-1.25rem)] items-center gap-1.5 rounded-sm bg-background/70 px-2 text-xs font-medium backdrop-blur">
        {seat.microphone ? (
          <MicIcon
            aria-label="Microphone on"
            className="size-3.5 text-muted-foreground"
          />
        ) : (
          <MicOffIcon
            aria-label="Muted"
            className="size-3.5 text-destructive"
          />
        )}
        <span
          className={cn(
            "truncate",
            !human && "font-mono text-agent-foreground",
          )}
        >
          {actor?.name ?? "Guest"}
        </span>
        {seat.local && <span className="font-normal text-faint">you</span>}
      </span>
    </div>
  );
}

/** Plays a LiveKit track in its own element, for as long as it is shown. */
function Media({
  track,
  kind,
  className,
}: {
  track: Track;
  kind: "video" | "audio";
  className?: string;
}) {
  const ref = useRef<HTMLVideoElement & HTMLAudioElement>(null);
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    track.attach(element);
    return () => void track.detach(element);
  }, [track]);
  return kind === "video" ? (
    <video
      ref={ref}
      autoPlay
      playsInline
      muted
      className={cn("absolute inset-0 size-full object-cover", className)}
    />
  ) : (
    <audio ref={ref} autoPlay />
  );
}

/** Who is in a meeting, as overlapping marks. */
function Faces({
  ids,
  actor,
}: {
  ids: string[];
  actor: (id: string) => Actor | undefined;
}) {
  return (
    <span className="flex -space-x-1.5">
      {[...new Set(ids)].map((id) => {
        const a = actor(id);
        return (
          <ActorMark
            key={id}
            kind={a?.kind ?? "agent"}
            name={a?.name ?? "?"}
            className="size-6 text-[10px] ring-2 ring-background"
          />
        );
      })}
    </span>
  );
}

const duration = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  const pad = (n: number) => String(n).padStart(2, "0");
  const hours = Math.floor(s / 3600);
  return `${hours ? `${hours}:` : ""}${pad(Math.floor(s / 60) % 60)}:${pad(s % 60)}`;
};
