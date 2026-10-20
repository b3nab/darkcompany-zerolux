import * as DocumentPicker from "expo-document-picker";
import * as Haptics from "expo-haptics";
import {
  useFocusEffect,
  useLocalSearchParams,
  useNavigation,
  usePathname,
  useRouter,
} from "expo-router";
import {
  ArrowDownIcon,
  MessagesSquareIcon,
  PanelRightIcon,
  PhoneIcon,
} from "lucide-react-native";
import type { NativeStackNavigationProp } from "expo-router";
import type { LucideIcon } from "lucide-react-native";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { LegendListRef } from "@legendapp/list/react-native";
import {
  ActionSheetIOS,
  Alert,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  View,
} from "react-native";
import type { TextInputInstance } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useCSSVariable } from "uniwind";
import {
  agentMembers,
  clockTime,
  dayLabel,
  deliveryLabels,
  draftOf,
  errorMessage,
  harnessLabels,
  newId,
  presenceLine,
  receipt,
  saveDraft,
  threadsOf,
  useChatWork,
  useUiPieces,
  useVoiceInput,
  composerAction,
  dictated,
  useVoice,
  workingSessions,
  sessionAccess,
} from "@zerolux/chat";
import type {
  Actor,
  Approval,
  ChatSession,
  ChatTurn,
  Conversation,
  Message,
} from "@zerolux/chat";
import { ApprovalCard } from "@/components/approval-card";
import { ChatAbout } from "@/components/chat-about";
import { ChatMark } from "@/components/chat-mark";
import { MessagePieces } from "@/components/extension-view";
import { Composer } from "@/components/composer";
import type { Chip } from "@/components/composer";
import { LiveWork, WorkLine } from "@/components/chat-work";
import { ActorMark } from "@/components/member";
import { MessageBody } from "@/components/message-body";
import { Screen } from "@/components/screen";
import { Listen } from "@/components/listen";
import { ChatList, GestureArea } from "@/components/ui/native";
import { Text } from "@/components/ui/text";
import { cn } from "@/lib/utils";
import { useSession } from "../../src/kernel";
import { useMe } from "../../src/me";
import { pickPhotos } from "../../src/photos";
import { asFile, useRecorder } from "../../src/voice";

type Row =
  | { key: string; kind: "day"; label: string }
  | {
      key: string;
      kind: "message";
      message: Message;
      continued: boolean;
      thread?: Conversation;
    }
  | { key: string; kind: "unsent"; text: string }
  | { key: string; kind: "approval"; approval: Approval }
  | { key: string; kind: "work"; actorId: string; turn: ChatTurn }
  | { key: string; kind: "activity"; sessions: ChatSession[] }
  | { key: string; kind: "note"; text: string };

const marks = { sent: "✓", delivered: "✓✓", read: "✓✓" };
/** The time as a file is named by it: "18.02". */
const clockName = () => new Date().toTimeString().slice(0, 5).replace(":", ".");
// Messages from one author a few minutes apart read as one turn.
const TURN = 5 * 60 * 1000;
const open = new Set<Approval["status"]>(["pending", "decided", "uncertain"]);

export default function ChatScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { chat, actors, name, storage, url } = useSession();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  // The unsent text waits in its chat while you are elsewhere in the app.
  const [draft, setDraft] = useState(() => draftOf(id));
  // A long press shows who has a message and who read it, as Info does in chat apps.
  const [detail, setDetail] = useState<string>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [about, setAbout] = useState(false);
  // Photos and files wait in the box until sent.
  const [chips, setChips] = useState<(Chip & { type?: string })[]>([]);
  const [picking, setPicking] = useState(false);
  // More than a screen above the latest messages: a button brings the reader back down.
  const [away, setAway] = useState(false);
  const list = useRef<LegendListRef>(null);
  const input = useRef<TextInputInstance>(null);
  const recorder = useRecorder();
  const [muted, faint] = useCSSVariable([
    "--color-muted-foreground",
    "--color-faint",
  ]).map(String);
  const conversation = chat.conversations.find((c) => c.id === id);
  const me = useMe().me?.id;
  const actor = (actorId: string | null) =>
    actors.find((a) => a.id === actorId);
  const thread = conversation?.kind === "thread";
  // Agents coordinate in threads under a chat; the owner reads them, the answer comes here.
  const parent = chat.conversations.find(
    (c) => c.id === conversation?.parent_id,
  );
  const threads = useMemo(
    () => (conversation ? threadsOf(conversation, chat.conversations) : []),
    [conversation, chat.conversations],
  );
  const openThreads = threads.filter((t) => !t.closed_at);
  // What each agent did for this chat, read back as far as the messages shown: only from
  // the sessions one may read, since another person's are private unless shared.
  const sessionIds = useMemo(
    () =>
      chat.sessions
        .filter(
          (s) =>
            conversation?.members.some((m) => m.session_id === s.id) &&
            sessionAccess(s, me).read,
        )
        .map((s) => s.id),
    [conversation, chat.sessions, me],
  );
  const work = useChatWork(
    id,
    sessionIds,
    chat.outputs,
    chat.messages[0]?.created_at,
  );
  const working = useMemo(
    () => (conversation ? workingSessions(conversation, chat.sessions) : []),
    [conversation, chat.sessions],
  );
  // A turn still running rides the working bubble; every other one sits under the message
  // that opened it.
  const { live, finished } = useMemo(() => {
    const live = new Map<string, ChatTurn>();
    const finished = new Map<string, { actorId: string; turn: ChatTurn }[]>();
    for (const { sessionId, turns } of work) {
      const actorId = chat.sessions.find((s) => s.id === sessionId)?.actor_id;
      const last = turns.at(-1);
      if (last && !last.ended && working.some((s) => s.id === sessionId))
        live.set(sessionId, last);
      for (const turn of turns)
        if (actorId && turn !== live.get(sessionId))
          finished.set(turn.delivery, [
            ...(finished.get(turn.delivery) ?? []),
            { actorId, turn },
          ]);
    }
    return { live, finished };
  }, [work, chat.sessions, working]);
  const workError = work.find((w) => w.error)?.error;
  // Opened work stays open as a running turn ends and moves under its message.
  const [opened, setOpened] = useState<ReadonlySet<string>>(new Set());
  const toggle = (key: string) =>
    setOpened((keys) => {
      const next = new Set(keys);
      if (!next.delete(key)) next.add(key);
      return next;
    });
  const { available: transcription, voices } = useVoice(url);
  // What extensions do with a message, under it once its details are open.
  const messagePieces = useUiPieces("message", url);
  const voice = useVoiceInput(
    recorder,
    {
      write: (said) => setDraft((now) => dictated(now, said)),
      send: async (said) => {
        if (conversation)
          await chat.send(conversation, { id: newId(), text: said });
      },
      // The recording is kept first, so a failed transcription loses nothing.
      // TODO: kernel: a file shared in a chat is announced to its members, as a message would be.
      keep:
        storage.available && conversation
          ? (audio) =>
              storage.upload(
                [
                  new File([audio], `Voice message ${clockName()}.m4a`, {
                    type: audio.type,
                  }),
                ],
                { conversation_id: conversation.id },
              )
          : undefined,
      transcription,
    },
    url,
  );
  // A row is drawn again only when its item or this changes: what else the rows read.
  const drawn = useMemo(
    () => ({ detail, opened, busy, voices, messagePieces }),
    [detail, opened, busy, voices, messagePieces],
  );

  // The chat on screen is the open one: a thread pushed over its chat takes over, and the
  // chat takes back when it shows again. A chat out of sight reads nothing.
  useFocusEffect(
    useCallback(() => {
      if (!conversation) return;
      chat.select(conversation);
      return () => chat.select(undefined);
      // Opening depends on the conversation appearing, not on every chat update.
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [conversation?.id]),
  );
  useEffect(() => saveDraft(id, draft), [id, draft]);
  // Entering a chat puts you in its box once the screen has slid in, not during the slide.
  const navigation =
    useNavigation<NativeStackNavigationProp<Record<string, object>>>();
  useEffect(
    () =>
      navigation.addListener("transitionEnd", (e) => {
        if (!e.data.closing) input.current?.focus();
      }),
    [navigation],
  );
  // Opening a member from the panel leaves the chat: the sheet goes with it.
  const pathname = usePathname();
  useEffect(() => setAbout(false), [pathname]);

  // Oldest first, as the conversation happened: the list anchors itself at the end and keeps
  // what the owner is reading in place when history loads above or rows change height.
  const rows = useMemo(() => {
    const result: Row[] = [];
    let day = "";
    let previous: Message | undefined;
    for (const message of chat.messages) {
      const label = dayLabel(message.created_at);
      if (label !== day)
        result.push({ key: `day-${message.seq}`, kind: "day", label });
      result.push({
        key: message.id,
        kind: "message",
        message,
        continued:
          label === day &&
          previous?.author_id === message.author_id &&
          message.created_at - previous.created_at < TURN,
        thread: threads.find((t) => t.root_message_id === message.id),
      });
      for (const delivery of message.deliveries)
        for (const { actorId, turn } of finished.get(delivery.id) ?? [])
          result.push({
            key: `work-${actorId}:${turn.delivery}`,
            kind: "work",
            actorId,
            turn,
          });
      day = label;
      previous = message;
    }
    for (const waiting of chat.unsent)
      if (waiting.conversation_id === id)
        result.push({ key: waiting.id, kind: "unsent", text: waiting.text });
    for (const approval of chat.approvals)
      if (approval.conversation_id === id && open.has(approval.status))
        result.push({ key: approval.id, kind: "approval", approval });
    if (working.length)
      result.push({ key: "activity", kind: "activity", sessions: working });
    if (workError)
      result.push({
        key: "work-error",
        kind: "note",
        text: `Agents' work: ${workError}`,
      });
    return result;
  }, [
    chat.messages,
    chat.unsent,
    chat.approvals,
    working,
    finished,
    workError,
    threads,
    id,
  ]);

  const action = composerAction({
    filled: Boolean(draft.trim() || chips.length),
    interruptible: false,
    recordable: transcription || storage.available,
    voice: voice.use,
    transcribing: voice.transcribing,
  });

  async function act(work: () => Promise<void>) {
    setBusy(true);
    setError("");
    try {
      await work();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  async function send() {
    const text = draft.trim();
    const files = chips;
    if (!conversation || (!text && !files.length)) return;
    // Cleared now: what the owner types while this one travels belongs to the next.
    setDraft("");
    setChips([]);
    setError("");
    let shared = false;
    try {
      // The files go first, so the words that speak of them follow them.
      if (files.length) {
        await storage.upload(
          await Promise.all(files.map((f) => asFile(f.uri, f.name, f.type))),
          { conversation_id: conversation.id },
        );
        shared = true;
      }
      if (text) await chat.send(conversation, { id: newId(), text });
    } catch (e) {
      setError(errorMessage(e));
      setDraft((typed) => (typed ? typed : text));
      if (!shared) setChips((now) => (now.length ? now : files));
    }
  }

  async function addPhotos(from: "library" | "camera") {
    setPicking(true);
    setError("");
    try {
      const picked = await pickPhotos(from, 10);
      setChips((now) => [
        ...now,
        ...picked.map((photo, i) => ({
          key: photo.uri,
          uri: photo.uri,
          name: `Photo ${clockName()}${picked.length > 1 ? `-${i + 1}` : ""}.jpg`,
          type: photo.media_type,
          image: true,
        })),
      ]);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setPicking(false);
    }
  }

  async function addFiles() {
    const picked = await DocumentPicker.getDocumentAsync({ multiple: true });
    if (picked.canceled) return;
    setChips((now) => [
      ...now,
      ...picked.assets.map((a) => ({
        key: a.uri,
        uri: a.uri,
        name: a.name,
        type: a.mimeType,
        image: Boolean(a.mimeType?.startsWith("image/")),
      })),
    ]);
  }

  function add() {
    void Haptics.selectionAsync();
    const choices: [string, () => void][] = [
      ["Photo library", () => void addPhotos("library")],
      ["Take photo", () => void addPhotos("camera")],
      ["Files", () => void addFiles()],
    ];
    if (Platform.OS === "ios")
      ActionSheetIOS.showActionSheetWithOptions(
        {
          options: [...choices.map(([label]) => label), "Cancel"],
          cancelButtonIndex: choices.length,
        },
        (index) => choices[index]?.[1](),
      );
    else
      Alert.alert("Add", undefined, [
        ...choices.map(([text, onPress]) => ({ text, onPress })),
        { text: "Cancel", style: "cancel" as const },
      ]);
  }

  function message(m: Message, continued: boolean, below?: Conversation) {
    const mine = m.author_id === me;
    const author = actor(m.author_id);
    const agent = author?.kind !== "human";
    const state = receipt(m.deliveries);
    const shown = detail === m.id;
    const stamp = (
      <Text
        className={cn("font-mono text-[11px] text-faint", mine && "self-end")}
      >
        {clockTime(m.created_at)}
        {state ? "  " : ""}
        <Text
          className={cn(
            "font-mono text-[11px]",
            state === "read" ? "text-agent-foreground" : "text-faint",
          )}
        >
          {state ? marks[state] : ""}
        </Text>
      </Text>
    );
    const deliveries = shown
      ? m.deliveries.map((delivery) => (
          <Text
            key={delivery.id}
            className="text-xs leading-[17px] text-muted-foreground"
          >
            {name(delivery.actor_id)} · {deliveryLabels[delivery.status]}
            {delivery.last_error ? `\n${delivery.last_error}` : ""}
          </Text>
        ))
      : null;
    if (mine)
      return (
        <Pressable
          className={cn(
            "max-w-[86%] gap-0.5 self-end rounded-md rounded-br-xs border border-human/25 bg-human/10 px-3 py-2",
            continued ? "mt-1" : "mt-3",
          )}
          onLongPress={() => setDetail(shown ? undefined : m.id)}
        >
          <MessageBody text={m.text} />
          {stamp}
          {deliveries}
          {shown && conversation ? (
            <MessagePieces
              pieces={messagePieces}
              context={{ conversation_id: conversation.id, message_id: m.id }}
            />
          ) : null}
          {below ? (
            <ThreadChip thread={below} name={name} className="mt-1.5" />
          ) : null}
        </Pressable>
      );
    return (
      <Pressable
        className={cn("flex-row gap-2.5", continued ? "mt-1" : "mt-3")}
        onLongPress={() => setDetail(shown ? undefined : m.id)}
      >
        <View className="w-8">
          {continued ? null : (
            <ActorMark
              kind={agent ? "agent" : "human"}
              name={author?.name ?? "?"}
            />
          )}
        </View>
        <View className="min-w-0 flex-1 gap-0.5">
          {continued ? null : (
            <View className="flex-row items-baseline gap-2">
              <Text
                className={cn(
                  "text-[13px]",
                  agent
                    ? "font-mono font-medium text-agent-foreground"
                    : "font-semibold",
                )}
              >
                {name(m.author_id)}
              </Text>
              {author?.harness ? (
                <Text className="font-mono text-[11px] text-faint">
                  {harnessLabels[author.harness]}
                </Text>
              ) : null}
            </View>
          )}
          <MessageBody text={m.text} />
          {author && voices?.some((v) => v.actor_id === author.id) ? (
            <View className="flex-row items-center gap-3">
              {stamp}
              <Listen id={m.id} actorId={author.id} text={m.text} />
            </View>
          ) : (
            stamp
          )}
          {deliveries}
          {shown && conversation ? (
            <MessagePieces
              pieces={messagePieces}
              context={{ conversation_id: conversation.id, message_id: m.id }}
            />
          ) : null}
          {below ? (
            <ThreadChip thread={below} name={name} className="mt-1.5" />
          ) : null}
        </View>
      </Pressable>
    );
  }

  function row(item: Row) {
    switch (item.kind) {
      case "day":
        return (
          <View className="my-3 flex-row items-center gap-3">
            <View className="h-px flex-1 bg-border" />
            <Text className="font-mono text-[11px] tracking-wider text-faint uppercase">
              {item.label}
            </Text>
            <View className="h-px flex-1 bg-border" />
          </View>
        );
      case "unsent":
        return (
          <View className="mt-1 max-w-[86%] gap-0.5 self-end rounded-md rounded-br-xs border border-dashed border-human/40 px-3 py-2">
            <Text className="text-base leading-[22px]">{item.text}</Text>
            <Text className="self-end font-mono text-[11px] text-faint">
              Not sent yet
            </Text>
          </View>
        );
      case "approval":
        return (
          <View className="mt-3">
            <ApprovalCard
              approval={item.approval}
              agent={actor(item.approval.actor_id)?.name ?? "An agent"}
              busy={busy}
              decide={(decision, options) =>
                void act(() => chat.decide(item.approval.id, decision, options))
              }
              answer={(answer) =>
                void act(() => chat.answer(item.approval.id, answer))
              }
            />
          </View>
        );
      case "work": {
        const key = `${item.actorId}:${item.turn.delivery}`;
        return (
          <WorkLine
            name={name(item.actorId)}
            turn={item.turn}
            open={opened.has(key)}
            toggle={() => toggle(key)}
          />
        );
      }
      case "activity":
        // One bubble per working agent: its step now, its turn so far, its Interrupt.
        return (
          <View className="mt-3 gap-1.5">
            {item.sessions.map((session) => {
              const turn = live.get(session.id);
              const key = `${session.actor_id}:${turn?.delivery}`;
              return (
                <LiveWork
                  key={session.id}
                  session={session}
                  name={name(session.actor_id)}
                  turn={turn}
                  open={opened.has(key)}
                  toggle={() => toggle(key)}
                />
              );
            })}
          </View>
        );
      case "note":
        return (
          <Text className="mt-2 font-mono text-[11px] text-faint">
            {item.text}
          </Text>
        );
      default:
        return message(item.message, item.continued, item.thread);
    }
  }

  const agents: Actor[] = conversation
    ? agentMembers(conversation, actors)
    : [];
  const tool = (
    Icon: LucideIcon,
    label: string,
    onPress: () => void,
    disabled: boolean,
  ) => (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled }}
      disabled={disabled || busy}
      onPress={onPress}
      hitSlop={6}
      className={cn(
        "size-10 items-center justify-center rounded-sm active:bg-accent",
        disabled && "opacity-40",
      )}
    >
      <Icon color={muted} size={20} strokeWidth={1.5} />
    </Pressable>
  );

  return (
    <Screen
      back
      title={conversation?.title ?? "Chat"}
      subtitle={
        conversation
          ? `${thread ? `Thread in «${parent?.title ?? "a chat"}»${conversation.closed_at ? " · closed" : ""} · ` : ""}${presenceLine(conversation, chat.sessions, name)}${chat.realtime === "live" ? "" : ` · ${chat.realtime}`}`
          : undefined
      }
      leading={
        conversation ? (
          <ChatMark conversation={conversation} agent={agents[0]} small />
        ) : null
      }
      action={
        conversation ? (
          <View className="flex-row items-center">
            {thread && !conversation.closed_at ? (
              <Pressable
                accessibilityRole="button"
                disabled={busy}
                onPress={() => void act(() => chat.close(conversation))}
                className="mr-1 h-8 justify-center rounded-sm border border-input bg-secondary px-3 active:bg-accent"
              >
                <Text className="text-[13px] font-medium">Close thread</Text>
              </Pressable>
            ) : null}
            {thread
              ? null
              : tool(
                  PhoneIcon,
                  "Meet",
                  () =>
                    router.push({
                      pathname: "/meetings",
                      params: { chat: conversation.id },
                    }),
                  false,
                )}
            {tool(
              PanelRightIcon,
              "About this chat",
              () => setAbout(true),
              false,
            )}
          </View>
        ) : null
      }
    >
      {openThreads.length ? (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          className="grow-0 border-b border-border"
          contentContainerClassName="items-center gap-2 px-3 py-2"
        >
          {openThreads.map((t) => (
            <ThreadChip key={t.id} thread={t} name={name} />
          ))}
        </ScrollView>
      ) : null}
      {conversation?.paused ? (
        <Text className="border-b border-border bg-attention/10 px-4 py-2 text-sm text-attention">
          {thread ? `Paused with «${parent?.title ?? "its chat"}»` : "Paused"}
        </Text>
      ) : null}
      {/* No textInputNativeID: on iOS it only serves an `offset`, and its invisible accessory
          view delays the input's resign, so after leaving the chat with the keyboard open the
          input could no longer bring it back (react-native-keyboard-controller#1615). */}
      <GestureArea className="flex-1" interpolator="ios">
        <ChatList
          ref={list}
          data={rows}
          extraData={drawn}
          keyExtractor={(item) => (item as Row).key}
          renderItem={({ item }) => row(item as Row)}
          contentContainerClassName="px-3 pt-1 pb-3"
          alignItemsAtEnd
          initialScrollAtEnd
          maintainScrollAtEnd
          maintainVisibleContentPosition={{ data: true, size: true }}
          onStartReached={() => void chat.loadEarlier()}
          onStartReachedThreshold={0.4}
          keyboardDismissMode="interactive"
          keyboardOffset={insets.bottom}
          onScroll={(e) => {
            const { contentOffset, contentSize, layoutMeasurement } =
              e.nativeEvent;
            const below =
              contentSize.height - layoutMeasurement.height - contentOffset.y;
            setAway(below > layoutMeasurement.height);
          }}
        />
        {away ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Back to the latest messages"
            onPress={() => void list.current?.scrollToEnd({ animated: true })}
            hitSlop={8}
            className="absolute right-4 bottom-4 size-10 items-center justify-center rounded-full border border-border bg-card shadow-md active:bg-accent"
          >
            <ArrowDownIcon color={muted} size={20} strokeWidth={1.75} />
          </Pressable>
        ) : null}
      </GestureArea>
      {thread ? (
        <Text
          className="border-t border-border bg-card px-4 pt-3 text-xs text-muted-foreground"
          style={{ paddingBottom: 12 + insets.bottom }}
        >
          {conversation?.closed_at
            ? "This thread is closed."
            : `Agents' thread in «${parent?.title ?? "the chat"}»`}
        </Text>
      ) : (
        <Composer
          error={error || chat.error || storage.error || voice.error}
          chips={chips}
          removeChip={(key) =>
            setChips((now) => now.filter((chip) => chip.key !== key))
          }
          inputRef={input}
          input={{
            value: draft,
            onChangeText: setDraft,
            placeholder:
              conversation?.kind === "group"
                ? `Write to ${conversation.title}`
                : `Write to ${agents[0]?.name ?? "the agent"}`,
          }}
          add={storage.available ? { onPress: add, busy: picking } : undefined}
          voice={{
            use: voice.use,
            transcribing: voice.transcribing,
            seconds: recorder.seconds,
            level: recorder.level,
            dictation: transcription,
            press: voice.press,
            release: voice.release,
            discard: voice.discard,
          }}
          action={action}
          onAction={() => void send()}
          waiting={
            action === "send" && !voice.use && !(draft.trim() || chips.length)
          }
        />
      )}
      <Modal
        visible={about}
        animationType="slide"
        presentationStyle="pageSheet"
        onRequestClose={() => setAbout(false)}
      >
        <View className="flex-1 bg-background">
          <View className="flex-row items-center justify-between border-b border-border px-5 py-3">
            <Text className="text-[17px] font-semibold">About this chat</Text>
            <Pressable
              accessibilityRole="button"
              onPress={() => setAbout(false)}
              hitSlop={12}
            >
              <Text className="text-base font-medium text-human-foreground">
                Done
              </Text>
            </Pressable>
          </View>
          {conversation ? (
            <ChatAbout
              conversation={conversation}
              actors={actors}
              sessions={chat.sessions}
              storage={storage}
            />
          ) : null}
        </View>
      </Modal>
    </Screen>
  );
}

/** A thread under a chat: its subject, who coordinates in it, and whether it is closed. */
function ThreadChip({
  thread,
  name,
  className,
}: {
  thread: Conversation;
  name: (actorId: string | null) => string;
  className?: string;
}) {
  const router = useRouter();
  const ion = String(useCSSVariable("--color-agent-foreground"));
  return (
    <Pressable
      accessibilityRole="link"
      onPress={() => router.push(`/chat/${thread.id}`)}
      className={cn(
        "max-w-[300px] flex-row items-center gap-1.5 self-start rounded-full border border-border bg-background px-3 py-1.5 active:bg-accent",
        thread.closed_at && "opacity-70",
        className,
      )}
    >
      <MessagesSquareIcon color={ion} size={14} strokeWidth={1.75} />
      <Text className="shrink text-xs leading-4 font-medium" numberOfLines={1}>
        {thread.title}
      </Text>
      <Text
        className="shrink text-xs leading-4 text-muted-foreground"
        numberOfLines={1}
      >
        · {thread.members.map((m) => name(m.actor_id)).join(", ")}
        {thread.closed_at ? " · closed" : ""}
      </Text>
    </Pressable>
  );
}
