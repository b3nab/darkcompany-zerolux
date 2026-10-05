import { useEffect, useState } from "react";
import { Room, RoomEvent, Track } from "livekit-client";
import type { AudioTrack, Participant, VideoTrack } from "livekit-client";
import { errorMessage, kernelUrl, request } from "./client";

export type { AudioTrack, Track, VideoTrack } from "livekit-client";

/** A live meeting: a LiveKit room that people and agents join. */
export interface Meeting {
  id: string;
  title: string;
  /** The chat it was started from, if any. */
  conversation_id: string | null;
  started_at: number;
  /** The actors in the room now. */
  participants: string[];
}
export interface RoomAccess {
  url: string;
  token: string;
}

// TODO: kernel: meetings, announced as the "meetings-v1" capability. `GET /meetings` lists the
// live ones; `POST /meetings {title, conversation_id}` opens one; `POST /meetings/{id}/join`
// answers `{url, token}` for its own LiveKit room, allowed to publish audio, video and screen and
// to set its own attributes, with `<actor>:<connection>` as identity; `POST /meetings/{id}/invite
// {actor_id}` brings an agent in to listen and answer; a `meeting.changed` event tells clients to
// list again; the room's transcript reaches it as data.

/** The live meetings; a kernel without meetings leaves the list empty. */
export function useMeetings(enabled: boolean, kernel = kernelUrl()) {
  const [server] = useState(kernel);
  const [meetings, setMeetings] = useState<Meeting[]>([]);
  const [error, setError] = useState("");
  const api = <T>(path: string, body?: unknown) =>
    request<T>(server, path, body);
  const list = async () =>
    setMeetings((await api<{ meetings: Meeting[] }>("/meetings")).meetings);
  useEffect(() => {
    if (enabled)
      list().then(
        () => setError(""),
        (e: unknown) => setError(errorMessage(e)),
      );
    // `list` only uses state setters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled]);
  return {
    meetings,
    error,
    async start(title: string, conversation_id: string | null = null) {
      const { meeting } = await api<{ meeting: Meeting }>("/meetings", {
        title,
        conversation_id,
      });
      await list();
      return meeting;
    },
    join: (meetingId: string) =>
      api<RoomAccess>(`/meetings/${meetingId}/join`, {}),
    async invite(meetingId: string, actor_id: string) {
      await api(`/meetings/${meetingId}/invite`, { actor_id });
      await list();
    },
  };
}
export type Meetings = ReturnType<typeof useMeetings>;

/** Someone in the room as the screen shows them: their tracks and whether they speak. */
export interface Seat {
  identity: string;
  actorId: string;
  local: boolean;
  speaking: boolean;
  microphone: boolean;
  hand: boolean;
  camera?: VideoTrack;
  screen?: VideoTrack;
  /** What the others hear; this client never plays its own. */
  audio?: AudioTrack;
}

/** A participant's track from `source`, unless it is muted. */
const shown = (participant: Participant, source: Track.Source) => {
  const publication = participant.getTrackPublication(source);
  return publication && !publication.isMuted ? publication : undefined;
};

/**
 * Inside one meeting's room while `meetingId` is set: who is there and what they share, and this
 * client's own microphone, camera, screen and raised hand. Leaving is unsetting `meetingId`.
 */
export function useRoom(
  meetingId: string | undefined,
  join: (meetingId: string) => Promise<RoomAccess>,
) {
  const [room, setRoom] = useState<Room>();
  const [error, setError] = useState("");
  // Room state lives in the LiveKit objects; every event re-reads it.
  const [, setVersion] = useState(0);
  const changed = () => setVersion((v) => v + 1);
  useEffect(() => {
    if (!meetingId) return;
    const current = new Room({ adaptiveStream: true, dynacast: true });
    for (const event of [
      RoomEvent.ParticipantConnected,
      RoomEvent.ParticipantDisconnected,
      RoomEvent.TrackSubscribed,
      RoomEvent.TrackUnsubscribed,
      RoomEvent.TrackMuted,
      RoomEvent.TrackUnmuted,
      RoomEvent.LocalTrackPublished,
      RoomEvent.LocalTrackUnpublished,
      RoomEvent.ActiveSpeakersChanged,
      RoomEvent.ParticipantAttributesChanged,
      RoomEvent.AudioPlaybackStatusChanged,
      RoomEvent.Disconnected,
    ] as const)
      current.on(event, changed);
    let left = false;
    (async () => {
      const { url, token } = await join(meetingId);
      if (left) return;
      await current.connect(url, token);
      if (left) return void current.disconnect();
      setError("");
      setRoom(current);
      await current.localParticipant.setMicrophoneEnabled(true);
    })().catch((e: unknown) => {
      if (!left) setError(errorMessage(e));
    });
    return () => {
      left = true;
      setRoom(undefined);
      void current.disconnect();
    };
    // `join` only builds a request; the room follows the meeting alone.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [meetingId]);

  const local = room?.localParticipant;
  const participants: Participant[] = room
    ? [room.localParticipant, ...room.remoteParticipants.values()]
    : [];
  const act = (work: () => Promise<unknown>) =>
    work().then(
      () => (setError(""), changed()),
      (e: unknown) => setError(errorMessage(e)),
    );
  return {
    error,
    /** Connected: before that there are no seats and nothing to toggle. */
    live: !!room,
    seats: participants.map<Seat>((p) => ({
      identity: p.identity,
      actorId: p.identity.split(":")[0]!,
      local: p === local,
      speaking: p.isSpeaking,
      microphone: p.isMicrophoneEnabled,
      hand: p.attributes.hand === "raised",
      camera: shown(p, Track.Source.Camera)?.videoTrack,
      screen: shown(p, Track.Source.ScreenShare)?.videoTrack,
      audio:
        p === local ? undefined : shown(p, Track.Source.Microphone)?.audioTrack,
    })),
    microphone: !!local?.isMicrophoneEnabled,
    camera: !!local?.isCameraEnabled,
    screen: !!local?.isScreenShareEnabled,
    hand: local?.attributes.hand === "raised",
    /** The browser held the others' sound back until the owner acts on the page. */
    muted: !!room && !room.canPlaybackAudio,
    setMicrophone: (on: boolean) =>
      act(async () => local?.setMicrophoneEnabled(on)),
    setCamera: (on: boolean) => act(async () => local?.setCameraEnabled(on)),
    setScreen: (on: boolean) =>
      act(async () => local?.setScreenShareEnabled(on)),
    setHand: (up: boolean) =>
      act(async () => local?.setAttributes({ hand: up ? "raised" : "" })),
    startAudio: () => act(async () => room?.startAudio()),
  };
}
