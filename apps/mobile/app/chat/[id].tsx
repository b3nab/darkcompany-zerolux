import * as DocumentPicker from "expo-document-picker";
import {
  useFocusEffect,
  useLocalSearchParams,
  usePathname,
  useRouter,
} from "expo-router";
import {
  AudioLinesIcon,
  MessagesSquareIcon,
  MicIcon,
  PanelRightIcon,
  PaperclipIcon,
  PhoneIcon,
  SendIcon,
  XIcon,
} from "lucide-react-native";
import type { LucideIcon } from "lucide-react-native";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Modal, Pressable, ScrollView, TextInput, View } from "react-native";
import { KeyboardStickyView } from "react-native-keyboard-controller";
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
  transcribe,
  workingIn,
} from "@zerolux/chat";
import type { Actor, Approval, Conversation, Message } from "@zerolux/chat";
import { ApprovalCard } from "@/components/approval-card";
import { ChatAbout } from "@/components/chat-about";
import { ChatMark } from "@/components/chat-mark";
import { ActorMark } from "@/components/member";
import { MessageBody } from "@/components/message-body";
import { Screen } from "@/components/screen";
import { ChatList, GestureArea } from "@/components/ui/native";
import { Text } from "@/components/ui/text";
import { cn } from "@/lib/utils";
import { useSession } from "../../src/kernel";
import { asFile, useVoice } from "../../src/voice";

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
  | { key: string; kind: "activity"; names: string[] };

const marks = { sent: "✓", delivered: "✓✓", read: "✓✓" };
const COMPOSER = "composer";
// Messages from one author a few minutes apart read as one turn.
const TURN = 5 * 60 * 1000;
const open = new Set<Approval["status"]>(["pending", "decided", "uncertain"]);

export default function ChatScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { chat, actors, name, storage, capabilities } = useSession();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  // The unsent text waits in its chat while you are elsewhere in the app.
  const [draft, setDraft] = useState(() => draftOf(id));
  const [detail, setDetail] = useState<string>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [about, setAbout] = useState(false);
  const [voice, setVoice] = useState<"dictation" | "message">();
  const recorder = useVoice();
  const [muted, faint, onLamp] = useCSSVariable([
    "--color-muted-foreground",
    "--color-faint",
    "--color-primary-foreground",
  ]).map(String);
  const conversation = chat.conversations.find((c) => c.id === id);
  const owner = actors.find((actor) => actor.kind === "human")?.id;
  const actor = (actorId: string) => actors.find((a) => a.id === actorId);
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
  const transcription = capabilities.includes("transcription-v1");

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
      day = label;
      previous = message;
    }
    for (const waiting of chat.unsent)
      if (waiting.conversation_id === id)
        result.push({ key: waiting.id, kind: "unsent", text: waiting.text });
    for (const approval of chat.approvals)
      if (approval.conversation_id === id && open.has(approval.status))
        result.push({ key: approval.id, kind: "approval", approval });
    const working = conversation ? workingIn(conversation, chat.sessions) : [];
    if (working.length)
      result.push({ key: "activity", kind: "activity", names: working });
    return result;
  }, [
    chat.messages,
    chat.unsent,
    chat.approvals,
    chat.sessions,
    conversation,
    threads,
    id,
  ]);

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
    if (!conversation || !text) return;
    // Cleared now: what the owner types while this one travels belongs to the next.
    setDraft("");
    setError("");
    try {
      await chat.send(conversation, { id: newId(), text });
    } catch (e) {
      setError(errorMessage(e));
      setDraft((typed) => (typed ? typed : text));
    }
  }

  async function attach() {
    const picked = await DocumentPicker.getDocumentAsync({ multiple: true });
    if (picked.canceled || !conversation) return;
    await act(async () =>
      storage.upload(
        await Promise.all(
          picked.assets.map((a) => asFile(a.uri, a.name, a.mimeType)),
        ),
        { conversation_id: conversation.id },
      ),
    );
  }

  async function record(purpose: "dictation" | "message") {
    await act(async () => {
      await recorder.start();
      setVoice(purpose);
    });
  }

  async function finish() {
    const purpose = voice;
    setVoice(undefined);
    if (!conversation) return;
    const at = new Date().toTimeString().slice(0, 5).replace(":", ".");
    await act(async () => {
      const audio = await recorder.stop(`Voice message ${at}.m4a`);
      if (!audio) return;
      if (purpose === "dictation") {
        const said = await transcribe(audio);
        setDraft((t) => (t.trim() ? `${t.trimEnd()} ${said}` : said));
      } else
        // TODO: kernel: a file shared in a chat is announced to its members, as a message would be.
        await storage.upload([audio], { conversation_id: conversation.id });
    });
  }

  function message(m: Message, continued: boolean, below?: Conversation) {
    const mine = m.author_id === owner;
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
          onPress={() => setDetail(shown ? undefined : m.id)}
        >
          <MessageBody text={m.text} />
          {stamp}
          {deliveries}
          {below ? (
            <ThreadChip thread={below} name={name} className="mt-1.5" />
          ) : null}
        </Pressable>
      );
    return (
      <Pressable
        className={cn("flex-row gap-2.5", continued ? "mt-1" : "mt-3")}
        onPress={() => setDetail(shown ? undefined : m.id)}
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
          {stamp}
          {deliveries}
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
              decide={(decision) =>
                void act(() => chat.decide(item.approval.id, decision))
              }
            />
          </View>
        );
      case "activity":
        return (
          <View className="mt-3 flex-row items-center gap-2 self-start rounded-full border border-agent/30 bg-agent/10 px-3 py-1.5">
            <View className="size-1.5 rounded-[1.5px] bg-agent" />
            <Text className="font-mono text-[12px] text-agent-foreground">
              {item.names.map(name).join(", ")}{" "}
              {item.names.length === 1 ? "is" : "are"} working
            </Text>
          </View>
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
          {thread
            ? `Paused with «${parent?.title ?? "its chat"}»: no agent is woken here until you resume that chat.`
            : "Paused: no agent is woken. New messages are saved and delivered when you resume."}
        </Text>
      ) : null}
      <GestureArea
        className="flex-1"
        interpolator="ios"
        textInputNativeID={COMPOSER}
      >
        <ChatList
          data={rows}
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
        />
      </GestureArea>
      <KeyboardStickyView offset={{ closed: 0, opened: insets.bottom }}>
        {error || chat.error || storage.error ? (
          <Text className="bg-card px-3.5 py-1.5 text-sm text-destructive">
            {error || chat.error || storage.error}
          </Text>
        ) : null}
        {thread ? (
          <Text
            className="border-t border-border bg-card px-4 pt-3 text-xs text-muted-foreground"
            style={{ paddingBottom: 12 + insets.bottom }}
          >
            {conversation?.closed_at
              ? "This thread is closed."
              : `Agents coordinate here; the answer comes in «${parent?.title ?? "the chat"}».`}
          </Text>
        ) : voice ? (
          <View
            className="flex-row items-center gap-3 border-t border-border bg-card px-4 pt-3"
            style={{ paddingBottom: 12 + insets.bottom }}
          >
            <View className="size-2.5 rounded-full bg-destructive" />
            <Text className="flex-1 font-mono text-sm">
              {voice === "dictation" ? "Listening" : "Recording"} ·{" "}
              {Math.floor(recorder.seconds / 60)}:
              {String(recorder.seconds % 60).padStart(2, "0")}
            </Text>
            {tool(
              XIcon,
              "Discard",
              () => {
                setVoice(undefined);
                void recorder.cancel();
              },
              false,
            )}
            <Pressable
              accessibilityRole="button"
              onPress={() => void finish()}
              className="h-10 flex-row items-center gap-2 rounded-sm bg-primary px-4 active:opacity-80"
            >
              <Text className="text-sm font-medium text-primary-foreground">
                {voice === "dictation" ? "Write it" : "Send"}
              </Text>
              <SendIcon color={onLamp} size={16} strokeWidth={1.75} />
            </Pressable>
          </View>
        ) : (
          <View
            className="flex-row items-end gap-1.5 border-t border-border bg-card px-2 pt-2"
            style={{ paddingBottom: 8 + insets.bottom }}
          >
            {tool(PaperclipIcon, "Attach a file", attach, !storage.available)}
            <View className="min-h-10 flex-1 flex-row items-end rounded-md border border-input bg-background">
              <TextInput
                nativeID={COMPOSER}
                className="max-h-36 flex-1 px-3 py-2.5 font-sans text-base text-foreground"
                placeholderTextColor={faint}
                value={draft}
                onChangeText={setDraft}
                placeholder={
                  conversation?.kind === "group"
                    ? `Write to ${conversation.title}`
                    : `Write to ${agents[0]?.name ?? "the agent"}`
                }
                multiline
              />
              {tool(
                MicIcon,
                "Dictate",
                () => void record("dictation"),
                !transcription,
              )}
            </View>
            {tool(
              AudioLinesIcon,
              "Record a voice message",
              () => void record("message"),
              !storage.available,
            )}
            <Pressable
              className={cn(
                "size-10 items-center justify-center rounded-sm bg-primary active:opacity-80",
                !draft.trim() && "opacity-40",
              )}
              disabled={!draft.trim()}
              onPress={send}
              accessibilityRole="button"
              accessibilityLabel="Send"
            >
              <SendIcon color={onLamp} size={18} strokeWidth={1.75} />
            </Pressable>
          </View>
        )}
      </KeyboardStickyView>
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
  name: (actorId: string) => string;
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
