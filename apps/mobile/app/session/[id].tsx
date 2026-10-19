import { useFocusEffect, useLocalSearchParams, useRouter } from "expo-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import type { TextInputInstance } from "react-native";
import {
  ChevronDownIcon,
  ClockIcon,
  ImagePlusIcon,
  PencilIcon,
  ChevronRightIcon,
  FileDiffIcon,
  ListChecksIcon,
  PanelRightIcon,
  SendIcon,
  SquareIcon,
  SquareTerminalIcon,
  XIcon,
} from "lucide-react-native";
import {
  ActionSheetIOS,
  ActivityIndicator,
  Alert,
  AppState,
  Image,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  Switch,
  TextInput,
  View,
} from "react-native";
import * as Haptics from "expo-haptics";
import Animated, { FadeIn } from "react-native-reanimated";
import { KeyboardStickyView } from "react-native-keyboard-controller";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { LegendListRef } from "@legendapp/list/react-native";
import { useCSSVariable } from "uniwind";
import {
  draftOf,
  errorMessage,
  folderName,
  harnessLabels,
  inputImagesError,
  MAX_INPUT_IMAGES,
  saveDraft,
  agentSettingFields,
  blockRuns,
  commandsFor,
  densityLabels,
  latestPlan,
  markSeen,
  placeApprovals,
  sessionBlocks,
  sessionCommand,
  sessionName,
  sessionOutputAt,
  sessionState,
  sessionTone,
  useArrivals,
  mentionAt,
  useSessionCommands,
  useSessionEvents,
  useSessionFiles,
  useSessionGit,
  useSessionSubagents,
  useSessionQueue,
  useSessionUsage,
  withMention,
  contextShare,
  percent,
  planMode,
  tokenCount,
  usdCost,
  useSessionLive,
  useSessionSettings,
  useVoice,
} from "@zerolux/chat";
import type {
  Actor,
  AgentSettings,
  Subagent,
  Approval,
  ApprovalItem,
  BlockRun,
  ChatSession,
  Density,
  InputMode,
  LiveItem,
  QueuedInput,
  SessionUsage,
  PlanStep,
  SessionBlock,
} from "@zerolux/chat";
import { ApprovalCard, ApprovalReceipt } from "@/components/approval-card";
import { ActorMark, Fact } from "@/components/member";
import { Screen } from "@/components/screen";
import { Segmented } from "@/components/segmented";
import {
  Delegation,
  Sharing,
  SessionCard,
  useInterrupt,
  useOrganize,
} from "@/components/session";
import { CiTrigger } from "@/components/ci-trigger";
import { GoalSection } from "@/components/goal";
import { Schedules } from "@/components/schedules";
import {
  SubagentLinks,
  SubagentList,
  useSubagentLinks,
} from "@/components/subagents";
import { ForkSession, useInputActions } from "@/components/session-fork";
import { ContinueInTerminal } from "@/components/continue-terminal";
import { SettingSelect } from "@/components/setting-select";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { LiveItemView, SessionRunView } from "@/components/session-blocks";
import { PlanSteps } from "@/components/tool-call";
import { ChatList } from "@/components/ui/native";
import { Text } from "@/components/ui/text";
import { cn } from "@/lib/utils";
import { setDensity, useDensity } from "../../src/density";
import { useSession } from "../../src/kernel";
import { useAccess } from "../../src/me";
import { dismissNotice } from "../../src/notices";
import { pickPhotos } from "../../src/photos";
import type { Photo } from "../../src/photos";

/** What the stream lists: the session's own blocks and the requests it made. */
type Item = SessionBlock | ApprovalItem;
/** What it is producing now, after the record's work. */
type LiveRow = { kind: "live"; key: string; item: LiveItem };
type Row = BlockRun<Item> | LiveRow;
/** Where in the native record a row's work is: its blocks are keyed by it. */
const rowAt = (row: Row) =>
  row.kind === "live" || row.kind === "approval"
    ? undefined
    : Number(row.key.split(".")[0]);

/**
 * One agent session, as the meta-harness apps show it: the agent and its state on top, its
 * work turn by turn in the middle, and below the box to write to it, with Interrupt in place
 * of Send while it works. Details and Stop, Resume, Take over are in About.
 */
export default function SessionPage() {
  // `at`: a place in its history to open at, as a search found it.
  const { id, at: place } = useLocalSearchParams<{
    id: string;
    at?: string;
  }>();
  const { workspace, chat, url } = useSession();
  const [about, setAbout] = useState(false);
  const router = useRouter();
  const muted = String(useCSSVariable("--color-muted-foreground"));
  const insets = useSafeAreaInsets();
  const session = chat.sessions.find((s) => s.id === id);
  // Its person does everything; others follow it, or work in it, as it is shared.
  const access = useAccess(session);
  const person = workspace?.actors.find(
    (a) => a.id === session?.owner_id,
  )?.name;
  const inputs = useInputActions(session);
  const { voices } = useVoice(url);
  const actorId = session?.actor_id;
  const voice = useMemo(
    () =>
      actorId && voices?.some((v) => v.actor_id === actorId)
        ? { actorId, sessionId: id }
        : undefined,
    [actorId, id, voices],
  );

  // How many files it changed, on the Changes button: for whoever may follow it.
  const changed =
    useSessionGit(access.read ? id : undefined, session?.output_at, url).status
      ?.changes.length ?? 0;
  // Read from the start, then again from where it stopped at each session.output notice.
  const {
    events,
    error: readError,
    more,
    earlier,
  } = useSessionEvents(id, chat.outputs[id]?.end);
  const blocks = useMemo(() => sessionBlocks(events), [events]);
  // Its subagents' work, from the tool calls that started them and in About: read again when
  // a tool call comes, which is when one starts.
  const { subagents } = useSessionSubagents(
    id,
    blocks.filter((block) => block.kind === "tool").length,
    url,
  );
  const subagentLinks = useSubagentLinks(id, subagents);
  // The session's requests stand where it made them: open while pending, a receipt after.
  const items = useMemo(
    () =>
      placeApprovals(
        blocks,
        chat.approvals.filter((a) => a.session_id === id),
      ),
    [blocks, chat.approvals, id],
  );
  // Tools run in a row are one list item, as on the web; what arrives live slides in.
  const runs = useMemo(() => blockRuns(items), [items]);
  // What it is producing right now follows its record, until the record has it.
  const live = useSessionLive(id, chat.live, events.length);
  const rows = useMemo<Row[]>(
    () => [
      ...runs,
      ...live.map((item) => ({
        kind: "live" as const,
        key: `live:${item.id}`,
        item,
      })),
    ],
    [runs, live],
  );
  const fresh = useArrivals(items);
  // Opened at a place in its history: earlier work is read until it is in, then shown once.
  const list = useRef<LegendListRef>(null);
  const target = place === undefined ? undefined : Number(place);
  const [reached, setReached] = useState<number>();
  // The row it opened at, marked for a moment.
  const [marked, setMarked] = useState<string>();
  useEffect(() => {
    if (!marked) return;
    const timer = setTimeout(() => setMarked(undefined), 2500);
    return () => clearTimeout(timer);
  }, [marked]);
  useEffect(() => {
    if (target === undefined || reached === target || !events.length) return;
    if (events[0]!.at > target && more) return earlier();
    const index = rows.findIndex((row) => {
      const offset = rowAt(row);
      return offset !== undefined && offset >= target;
    });
    if (index < 0) return;
    setReached(target);
    setMarked(rows[index]!.key);
    requestAnimationFrame(() =>
      list.current?.scrollToIndex({
        index,
        animated: false,
        viewPosition: 0.5,
      }),
    );
    // `earlier` reads the page before; the rows say when the place is in.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target, reached, events, rows, more]);
  const plan = latestPlan(blocks);
  // Where its work stood when /compact started: the summary, or why it failed, comes after.
  const [compactAfter, setCompactAfter] = useState<string | null>();
  const compacting =
    compactAfter !== undefined &&
    !blocks
      .slice(blocks.findIndex((block) => block.key === compactAfter) + 1)
      .some((block) => block.kind === "compacted" || block.kind === "error");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  // A row is drawn again only when its item or this changes: what else the rows read.
  const drawn = useMemo(
    () => ({ marked, busy, read: access.read, mine: access.mine, voice }),
    [marked, busy, access.read, access.mine, voice],
  );
  const act = async (work: () => Promise<unknown>) => {
    setBusy(true);
    setError("");
    try {
      await work();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  // What it wrote while you look at it is seen; while the app is in the background, it waits.
  const at = session && sessionOutputAt(chat, session);
  useFocusEffect(
    useCallback(() => {
      if (!at) return;
      const look = () => {
        if (AppState.currentState !== "active") return;
        markSeen(id, at);
        dismissNotice(id);
      };
      look();
      const watch = AppState.addEventListener("change", look);
      return () => watch.remove();
    }, [id, at]),
  );
  if (!session)
    return (
      <Screen back title="Session">
        <Text className="px-5 py-6 text-sm text-muted-foreground">
          This session is no longer listed.
        </Text>
      </Screen>
    );
  const agent = workspace?.actors.find((a) => a.id === session.actor_id);
  // Without an agent, the session goes by its own title.
  const name = agent?.name ?? sessionName(session, []);
  const chatTitle = (chatId: string) =>
    chat.conversations.find((c) => c.id === chatId)?.title;
  return (
    <Screen
      back
      title={
        agent ? `${agent.name} · ${session.title || "Untitled session"}` : name
      }
      subtitle={`${sessionState(session)} · ${harnessLabels[session.harness] ?? session.harness} · ${folderName(session.workspace)}`}
      leading={
        <ActorMark
          kind="agent"
          name={name}
          tone={sessionTone(session)}
          size="sm"
        />
      }
      action={
        <View className="flex-row">
          {access.read ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={
                changed ? `Changes, ${changed} files` : "Changes"
              }
              onPress={() => router.push(`/changes/${id}`)}
              hitSlop={6}
              className="size-10 items-center justify-center rounded-sm active:bg-accent"
            >
              <FileDiffIcon color={muted} size={20} strokeWidth={1.5} />
              {changed ? (
                <View className="absolute top-0.5 right-0 min-w-4 items-center rounded-full bg-primary px-1">
                  <Text className="font-mono text-[10px] leading-4 text-primary-foreground">
                    {changed}
                  </Text>
                </View>
              ) : null}
            </Pressable>
          ) : null}
          {access.write ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Terminal"
              onPress={() => router.push(`/terminal/${id}`)}
              hitSlop={6}
              className="size-10 items-center justify-center rounded-sm active:bg-accent"
            >
              <SquareTerminalIcon color={muted} size={20} strokeWidth={1.5} />
            </Pressable>
          ) : null}
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="About this session"
            onPress={() => setAbout(true)}
            hitSlop={6}
            className="size-10 items-center justify-center rounded-sm active:bg-accent"
          >
            <PanelRightIcon color={muted} size={20} strokeWidth={1.5} />
          </Pressable>
        </View>
      }
    >
      <SubagentLinks value={subagentLinks}>
        <ChatList
          ref={list}
          data={rows}
          extraData={drawn}
          keyExtractor={(row) => (row as Row).key}
          renderItem={({ item }) =>
            (item as Row).kind === "live" ? (
              <LiveItemView item={(item as LiveRow).item} />
            ) : (
              <View
                className={cn(
                  "rounded-md",
                  marked === (item as Row).key && "bg-primary/10",
                )}
              >
                <SessionRunView
                  run={item as BlockRun<Item>}
                  fresh={fresh}
                  chatTitle={chatTitle}
                  inputMenu={access.read ? inputs.open : undefined}
                  voice={voice}
                  renderApproval={(approval: Approval) =>
                    // Its requests are its person's to decide; others see them wait.
                    approval.status === "pending" && access.mine ? (
                      <ApprovalCard
                        approval={approval}
                        agent={name}
                        busy={busy}
                        decide={(decision, options) =>
                          void act(() =>
                            chat.decide(approval.id, decision, options),
                          )
                        }
                        answer={(answer) =>
                          void act(() => chat.answer(approval.id, answer))
                        }
                      />
                    ) : (
                      <ApprovalReceipt
                        approval={approval}
                        waitingFor={access.mine ? undefined : person}
                      />
                    )
                  }
                />
              </View>
            )
          }
          contentContainerClassName="gap-3 px-3 pt-3 pb-3"
          alignItemsAtEnd
          initialScrollAtEnd
          maintainScrollAtEnd
          maintainVisibleContentPosition={{ data: true, size: true }}
          // The latest work comes first; earlier work loads while scrolling up to it.
          onStartReached={more ? earlier : undefined}
          onStartReachedThreshold={0.4}
          keyboardDismissMode="interactive"
          keyboardOffset={insets.bottom}
          ListEmptyComponent={
            <Text
              className={
                readError ? "text-sm text-destructive" : "text-sm text-faint"
              }
            >
              {readError || "Nothing recorded yet."}
            </Text>
          }
        />
      </SubagentLinks>
      <Composer
        session={session}
        name={name}
        notice={error}
        compacting={compacting}
        compactStarted={() => setCompactAfter(blocks.at(-1)?.key ?? null)}
      >
        {plan?.some((step) => step.status !== "done") ? (
          <PlanBar steps={plan} />
        ) : null}
      </Composer>
      {inputs.sheet}
      <Modal
        visible={about}
        animationType="slide"
        presentationStyle="pageSheet"
        onRequestClose={() => setAbout(false)}
      >
        <About
          subagents={subagents}
          session={session}
          agentId={agent?.id}
          name={name}
          close={() => setAbout(false)}
        />
      </Modal>
    </Screen>
  );
}

/**
 * The box to write to the session as its owner: the words go into the native session, a new
 * turn when it is idle, or joining the turn it is working on. With nothing typed while it
 * works, Interrupt takes Send's place. `/compact` runs the harness's own compaction instead,
 * and typing "/" offers the commands. What stays above it while the session works, as its
 * plan, comes as children.
 */
function Composer({
  session,
  name,
  notice,
  compacting,
  compactStarted,
  children,
}: {
  session: ChatSession;
  name: string;
  notice: string;
  compacting: boolean;
  compactStarted: () => void;
  children?: ReactNode;
}) {
  const insets = useSafeAreaInsets();
  const { chat, url } = useSession();
  const { write } = useAccess(session);
  const stop = useInterrupt(session);
  const harnessCommands = useSessionCommands(session.id, url);
  const queue = useSessionQueue(session.id, chat.live);
  const usage = useSessionUsage(session.id, chat.live);
  // The unsent text waits in its session while you are elsewhere in the app.
  const [draft, setDraft] = useState(() => draftOf(session.id));
  const box = useRef<TextInputInstance>(null);
  const [cursor, setCursor] = useState(draft.length);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");
  // Photos go with the words, or alone; they wait here until sent.
  const [photos, setPhotos] = useState<Photo[]>([]);
  const [picking, setPicking] = useState(false);
  const [faint, onLamp, agent, muted] = useCSSVariable([
    "--color-faint",
    "--color-primary-foreground",
    "--color-agent",
    "--color-muted-foreground",
  ]).map(String);
  const commands = commandsFor(draft, harnessCommands);
  // "@" offers the session's files; a command's menu comes first.
  const mention = commands.length ? undefined : mentionAt(draft, cursor);
  const files = useSessionFiles(session.id, mention?.query, url);
  const mentionFile = (path: string) => {
    if (!mention) return;
    void Haptics.selectionAsync();
    const next = withMention(draft, mention, path);
    setDraft(next.text);
    setCursor(next.cursor);
    requestAnimationFrame(() =>
      box.current?.setSelection(next.cursor, next.cursor),
    );
  };
  useEffect(() => saveDraft(session.id, draft), [session.id, draft]);
  const open = write && session.status === "connected";
  // While it works, words join the turn; held, Send waits for the turn or stops it first.
  const send = async (mode?: InputMode) => {
    const text = draft;
    const sent = photos;
    if (!open || (!text.trim() && !sent.length)) return;
    const command = sessionCommand(text);
    const refused = command
      ? sent.length
        ? "Send the photos without a command"
        : undefined
      : inputImagesError(
          sent.map((photo) => ({ type: photo.media_type, size: photo.size })),
        );
    if (refused) return setError(refused);
    setSending(true);
    setError("");
    try {
      if (command?.name === "compact") {
        await chat.compact(session.id, command.args);
        compactStarted();
      } else
        await chat.input(
          session.id,
          text.trim(),
          mode,
          sent.map(({ media_type, data }) => ({ media_type, data })),
        );
      // What was typed or picked meanwhile stays.
      setDraft((now) => (now === text ? "" : now));
      setPhotos((now) => now.filter((photo) => !sent.includes(photo)));
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setSending(false);
    }
  };
  // Claude Code in a terminal only takes words, into the running turn.
  const choosable = !(
    session.harness === "claude-code" && session.origin !== "owned"
  );
  const filled = Boolean(draft.trim() || photos.length);
  const interrupting = !filled && stop.allowed;
  const room = MAX_INPUT_IMAGES - photos.length;
  const pick = (from: "library" | "camera") => {
    setPicking(true);
    setError("");
    pickPhotos(from, room)
      .then((picked) =>
        setPhotos((now) => [...now, ...picked].slice(0, MAX_INPUT_IMAGES)),
      )
      .catch((e: unknown) => setError(errorMessage(e)))
      .finally(() => setPicking(false));
  };
  const attach = () => {
    void Haptics.selectionAsync();
    if (Platform.OS === "ios")
      ActionSheetIOS.showActionSheetWithOptions(
        {
          options: ["Photo library", "Take photo", "Cancel"],
          cancelButtonIndex: 2,
        },
        (index) => {
          if (index === 0) pick("library");
          else if (index === 1) pick("camera");
        },
      );
    else
      Alert.alert("Attach a photo", undefined, [
        { text: "Photo library", onPress: () => pick("library") },
        { text: "Take photo", onPress: () => pick("camera") },
        { text: "Cancel", style: "cancel" },
      ]);
  };
  const modes: [string, InputMode][] = [
    ["Send when this turn ends", "queue"],
    ["Stop the turn and send", "interrupt"],
  ];
  const chooseMode = () => {
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    if (Platform.OS === "ios")
      ActionSheetIOS.showActionSheetWithOptions(
        {
          options: [...modes.map(([label]) => label), "Cancel"],
          cancelButtonIndex: modes.length,
          destructiveButtonIndex: 1,
        },
        (index) => {
          if (index < modes.length) void send(modes[index]![1]);
        },
      );
    else
      Alert.alert(`Send to ${name}`, undefined, [
        ...modes.map(([text, mode]) => ({
          text,
          onPress: () => void send(mode),
        })),
        { text: "Cancel", style: "cancel" as const },
      ]);
  };
  const shown = notice || error || stop.error;
  return (
    <KeyboardStickyView offset={{ closed: 0, opened: insets.bottom }}>
      <View
        className="gap-2 border-t border-border bg-card px-2 pt-2"
        style={{ paddingBottom: 8 + insets.bottom }}
      >
        {children}
        {compacting ? (
          <View className="flex-row items-center gap-2 px-1.5">
            <ActivityIndicator
              size="small"
              color={agent}
              style={{ transform: [{ scale: 0.7 }] }}
            />
            <Text className="flex-1 text-xs text-muted-foreground">
              Compacting: the summary, or why it failed, appears in the work.
            </Text>
          </View>
        ) : null}
        {queue.length ? (
          <View className="gap-1.5">
            <Text className="px-1.5 font-mono text-[11px] text-faint">
              Waiting for the turn to end · {queue.length}
            </Text>
            {queue.map((item) => (
              <QueueCard key={item.id} session={session} item={item} />
            ))}
          </View>
        ) : null}
        {mention && files.length ? (
          <View className="max-h-56 overflow-hidden rounded-md border border-border bg-background">
            <ScrollView keyboardShouldPersistTaps="always">
              {files.map((path) => {
                const cut = path.lastIndexOf("/") + 1;
                return (
                  <Pressable
                    key={path}
                    onPress={() => mentionFile(path)}
                    accessibilityRole="button"
                    accessibilityLabel={`Mention ${path}`}
                    className="flex-row items-baseline gap-2 px-3 py-2.5 active:bg-accent"
                  >
                    <Text className="font-mono text-sm text-agent-foreground">
                      {path.slice(cut)}
                    </Text>
                    <Text
                      numberOfLines={1}
                      className="flex-1 font-mono text-xs text-faint"
                    >
                      {path.slice(0, cut)}
                    </Text>
                  </Pressable>
                );
              })}
            </ScrollView>
          </View>
        ) : null}
        {commands.length ? (
          <View className="overflow-hidden rounded-md border border-border bg-background">
            {commands.map((command) => (
              <Pressable
                key={command.invoke}
                onPress={() => {
                  void Haptics.selectionAsync();
                  setDraft(`${command.invoke} `);
                }}
                accessibilityRole="button"
                className="flex-row items-baseline gap-2 px-3 py-2.5 active:bg-accent"
              >
                <Text className="font-mono text-sm text-agent-foreground">
                  {command.invoke}
                  {command.hint ? (
                    <Text className="font-mono text-xs text-faint">
                      {" "}
                      {command.hint}
                    </Text>
                  ) : null}
                </Text>
                <Text
                  numberOfLines={1}
                  className="flex-1 text-xs text-muted-foreground"
                >
                  {command.description}
                </Text>
              </Pressable>
            ))}
          </View>
        ) : null}
        {shown ? (
          <Text className="px-1.5 text-sm text-destructive">{shown}</Text>
        ) : null}
        {photos.length ? (
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerClassName="gap-2 px-0.5"
          >
            {photos.map((photo, i) => (
              <View key={photo.uri} className="relative">
                <Image
                  source={{ uri: photo.uri }}
                  accessibilityLabel={`Photo ${i + 1} of ${photos.length}`}
                  className="size-14 rounded-md border border-border"
                />
                <Pressable
                  onPress={() =>
                    setPhotos((now) => now.filter((other) => other !== photo))
                  }
                  accessibilityRole="button"
                  accessibilityLabel={`Remove photo ${i + 1}`}
                  hitSlop={8}
                  className="absolute -top-1.5 -right-1.5 size-5 items-center justify-center rounded-full border border-border bg-card"
                >
                  <XIcon color={muted} size={11} strokeWidth={2.5} />
                </Pressable>
              </View>
            ))}
          </ScrollView>
        ) : null}
        {write ? (
          <View className="flex-row items-end gap-1.5">
            {choosable ? (
              <Pressable
                onPress={attach}
                disabled={!open || picking || room <= 0}
                accessibilityRole="button"
                accessibilityLabel="Attach a photo"
                hitSlop={4}
                className={cn(
                  "size-10 items-center justify-center rounded-sm active:bg-accent",
                  (!open || room <= 0) && "opacity-40",
                )}
              >
                {picking ? (
                  <ActivityIndicator size="small" color={muted} />
                ) : (
                  <ImagePlusIcon color={muted} size={20} strokeWidth={1.5} />
                )}
              </Pressable>
            ) : null}
            <View className="min-h-10 flex-1 flex-row items-end rounded-md border border-input bg-background">
              <TextInput
                className={cn(
                  "max-h-36 flex-1 px-3 py-2.5 font-sans text-base text-foreground",
                  !open && "opacity-60",
                )}
                placeholderTextColor={faint}
                placeholder={
                  open
                    ? stop.allowed
                      ? `Add to ${name}'s turn`
                      : `Write to ${name}, or / for commands`
                    : sessionState(session)
                }
                ref={box}
                editable={open}
                value={draft}
                onChangeText={setDraft}
                onSelectionChange={(event) =>
                  setCursor(event.nativeEvent.selection.start)
                }
                multiline
              />
            </View>
            {interrupting ? (
              <Pressable
                className="size-10 items-center justify-center rounded-sm bg-primary active:opacity-80"
                disabled={stop.busy}
                onPress={() => void stop.interrupt()}
                accessibilityRole="button"
                accessibilityLabel="Interrupt"
              >
                <SquareIcon
                  color={onLamp}
                  fill={onLamp}
                  size={14}
                  strokeWidth={1.75}
                />
              </Pressable>
            ) : (
              <Pressable
                className={cn(
                  "size-10 items-center justify-center rounded-sm bg-primary active:opacity-80",
                  (!open || !filled || sending) && "opacity-40",
                )}
                disabled={!open || !filled || sending}
                onPress={() => void send()}
                onLongPress={
                  stop.allowed && open && choosable ? chooseMode : undefined
                }
                accessibilityRole="button"
                accessibilityLabel="Send"
                accessibilityHint={
                  stop.allowed && choosable
                    ? "Joins the turn in progress; hold to send it when the turn ends, or to stop the turn and send"
                    : undefined
                }
              >
                <SendIcon color={onLamp} size={18} strokeWidth={1.75} />
              </Pressable>
            )}
          </View>
        ) : (
          <Text className="px-1.5 pb-1 text-xs text-muted-foreground">
            Shared with you to read: its person works in it.
          </Text>
        )}
        {write && stop.allowed && filled && !sessionCommand(draft) ? (
          <Text className="px-1.5 text-xs text-faint">
            {choosable
              ? "Joins the turn in progress. Hold Send to send it when the turn ends, or to stop the turn and send."
              : "Joins the turn in progress."}
          </Text>
        ) : null}
        <View className="flex-row items-start gap-2">
          <View className="flex-1">
            {write && session.status !== "stopped" ? (
              <SettingsBar session={session} />
            ) : null}
          </View>
          <ContextMeter
            usage={usage}
            compact={
              open ? () => setDraft((now) => now || "/compact ") : undefined
            }
          />
        </View>
      </View>
    </KeyboardStickyView>
  );
}

/**
 * The session's plan, pinned above the box: how far it is and the step in hand; opened,
 * every step.
 */
function PlanBar({ steps }: { steps: PlanStep[] }) {
  const [open, setOpen] = useState(false);
  const [agent, faint] = useCSSVariable(["--color-agent", "--color-faint"]).map(
    String,
  );
  const done = steps.filter((step) => step.status === "done").length;
  const current =
    steps.find((step) => step.status === "active") ??
    steps.find((step) => step.status !== "done");
  return (
    <View className="overflow-hidden rounded-md border border-border bg-background">
      <Pressable
        onPress={() => {
          void Haptics.selectionAsync();
          setOpen(!open);
        }}
        accessibilityRole="button"
        accessibilityLabel={`Plan: ${done} of ${steps.length} done`}
        accessibilityState={{ expanded: open }}
        className="min-h-9 flex-row items-center gap-2 px-3 py-1.5 active:bg-accent"
      >
        <ListChecksIcon color={agent} size={14} strokeWidth={1.75} />
        <Text className="font-mono text-[11px] text-faint">
          {done} of {steps.length}
        </Text>
        <Text
          numberOfLines={1}
          className={cn("flex-1 text-[13px]", open && "opacity-0")}
        >
          {current?.text}
        </Text>
        <View style={{ transform: [{ rotate: open ? "180deg" : "0deg" }] }}>
          <ChevronDownIcon color={faint} size={14} strokeWidth={1.5} />
        </View>
      </Pressable>
      {open ? (
        <Animated.View entering={FadeIn.duration(160)}>
          <ScrollView
            className="max-h-60 border-t border-border"
            contentContainerClassName="px-3 py-2"
          >
            <PlanSteps steps={steps} />
          </ScrollView>
        </Animated.View>
      ) : null}
    </View>
  );
}

/** The session's details and its other controls, in a sheet like a chat's About. */
function About({
  subagents,
  session,
  agentId,
  name,
  close,
}: {
  subagents?: Subagent[];
  session: ChatSession;
  agentId?: string;
  name: string;
  close: () => void;
}) {
  const access = useAccess(session);
  const router = useRouter();
  const faint = String(useCSSVariable("--color-faint"));
  const density = useDensity();
  return (
    <View className="flex-1 bg-background">
      <View className="flex-row items-center justify-between border-b border-border px-5 py-3">
        <Text className="text-[17px] font-semibold">About this session</Text>
        <Pressable accessibilityRole="button" onPress={close} hitSlop={12}>
          <Text className="text-base font-medium text-human-foreground">
            Done
          </Text>
        </Pressable>
      </View>
      <ScrollView contentContainerClassName="gap-6 px-5 py-6">
        {agentId ? (
          <Pressable
            onPress={() => {
              close();
              router.push(`/member/${agentId}`);
            }}
            accessibilityRole="button"
            className="border-y border-border py-2"
          >
            <Fact label="Agent">
              <View className="flex-row items-center gap-2">
                <ActorMark kind="agent" name={name} size="sm" />
                <Text className="flex-1 font-mono text-sm text-agent-foreground">
                  {name}
                </Text>
                <ChevronRightIcon color={faint} size={16} strokeWidth={1.5} />
              </View>
            </Fact>
          </Pressable>
        ) : null}
        <View className="gap-2">
          <Text className="text-sm text-faint">Density</Text>
          <Segmented<Density>
            options={Object.entries(densityLabels) as [Density, string][]}
            value={density}
            choose={setDensity}
          />
        </View>
        <Sharing session={session} />
        <Delegation session={session} close={close} />
        <SubagentList
          sessionId={session.id}
          subagents={subagents}
          close={close}
        />
        {access.mine ? <Organize session={session} /> : null}
        <GoalSection session={session} />
        <ForkSession session={session} close={close} />
        <ContinueInTerminal session={session} />
        <Schedules session={session} />
        <CiTrigger session={session} />
        <UsageFacts sessionId={session.id} />
        <SessionCard session={session} name={name} facts />
      </ScrollView>
    </View>
  );
}

/**
 * Under the box, the session's model, effort and permissions as pills, as on the web: one
 * changes at a time, through its harness, which confirms it or says why not.
 */
function SettingsBar({ session }: { session: ChatSession }) {
  const { url } = useSession();
  const settings = useSessionSettings(
    session.id,
    `${session.status}:${session.activity}`,
    url,
  );
  const [error, setError] = useState("");
  const values = settings.data?.values ?? {};
  const models = settings.data?.models ?? [];
  const editable = settings.data?.editable ?? [];
  if (!settings.data || !editable.length) return null;
  const harness = session.harness as Actor["harness"];
  const fields = agentSettingFields(harness, models, values.model);
  // Plan mode is a switch beside them, set in each harness's own terms.
  const plan = planMode(harness, values, editable);
  const apply = (change: AgentSettings) => {
    setError("");
    settings.apply(change).catch((e: unknown) => setError(errorMessage(e)));
  };
  return (
    <View className="gap-1 px-0.5">
      <View className="flex-row flex-wrap gap-1.5">
        {fields.map(({ key, label, options }) => (
          <SettingSelect
            key={key}
            compact
            label={label}
            value={values[key] ?? ""}
            options={options}
            placeholder={`${label}: the harness's own`}
            disabled={
              !editable.includes(key) || Object.keys(options).length === 0
            }
            onChange={(value) => apply({ [key]: value })}
          />
        ))}
        {plan ? (
          <Pressable
            accessibilityRole="switch"
            accessibilityLabel="Plan"
            accessibilityState={{ checked: plan.on }}
            onPress={() => apply(plan.change(!plan.on))}
            className={cn(
              "rounded-full border border-border px-2.5 py-1 active:bg-accent",
              plan.on && "border-primary bg-primary/15",
            )}
          >
            <Text
              className={cn(
                "text-xs",
                plan.on ? "text-foreground" : "text-muted-foreground",
              )}
            >
              Plan
            </Text>
          </Pressable>
        ) : null}
      </View>
      {error || settings.error ? (
        <Text className="text-xs text-attention">
          {error || settings.error}
        </Text>
      ) : null}
    </View>
  );
}

/**
 * An input of the owner's waiting for the turn to end, above the box. Codex lets it be
 * rewritten or taken back; the other harnesses show it as it waits.
 */
function QueueCard({
  session,
  item,
}: {
  session: ChatSession;
  item: QueuedInput;
}) {
  const { chat } = useSession();
  const editable = session.harness === "codex";
  const [editing, setEditing] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [faint, muted] = useCSSVariable([
    "--color-faint",
    "--color-muted-foreground",
  ]).map(String);
  const act = async (work: () => Promise<unknown>) => {
    setBusy(true);
    setError("");
    try {
      await work();
      setEditing(undefined);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <View className="gap-2 rounded-md border border-border bg-background px-3 py-2">
      <View className="flex-row items-start gap-2">
        <View className="mt-1">
          <ClockIcon color={faint} size={13} strokeWidth={1.75} />
        </View>
        {editing === undefined ? (
          <Text numberOfLines={3} className="flex-1 text-sm">
            {item.text}
          </Text>
        ) : (
          <TextInput
            value={editing}
            onChangeText={setEditing}
            multiline
            autoFocus
            accessibilityLabel="Waiting input"
            className="max-h-28 flex-1 font-sans text-sm text-foreground"
          />
        )}
        {editable && editing === undefined ? (
          <View className="flex-row gap-3">
            <Pressable
              onPress={() => setEditing(item.text)}
              accessibilityRole="button"
              accessibilityLabel="Edit the waiting input"
              hitSlop={8}
            >
              <PencilIcon color={muted} size={15} strokeWidth={1.75} />
            </Pressable>
            <Pressable
              onPress={() =>
                void act(() => chat.removeQueued(session.id, item.id))
              }
              disabled={busy}
              accessibilityRole="button"
              accessibilityLabel="Take back the waiting input"
              hitSlop={8}
            >
              <XIcon color={muted} size={15} strokeWidth={2} />
            </Pressable>
          </View>
        ) : null}
      </View>
      {editing !== undefined ? (
        <View className="flex-row justify-end gap-2">
          <Button
            size="sm"
            variant="outline"
            disabled={busy}
            onPress={() => setEditing(undefined)}
          >
            <Text>Cancel</Text>
          </Button>
          <Button
            size="sm"
            disabled={busy || !editing.trim()}
            onPress={() =>
              void act(() =>
                chat.editQueued(session.id, item.id, editing.trim()),
              )
            }
          >
            <Text>Save</Text>
          </Button>
        </View>
      ) : null}
      {error ? <Text className="text-xs text-destructive">{error}</Text> : null}
    </View>
  );
}

/**
 * How full the session's context is, as its harness last said: a short bar by the box that
 * warms as it fills. For the owner, a tap starts `/compact` in the box.
 */
function ContextMeter({
  usage,
  compact,
}: {
  usage: SessionUsage | null;
  compact?: () => void;
}) {
  const share = contextShare(usage);
  if (share === undefined) return null;
  const tone =
    share >= 0.95
      ? "bg-destructive"
      : share >= 0.8
        ? "bg-attention"
        : "bg-agent";
  return (
    <Pressable
      onPress={compact}
      disabled={!compact}
      accessibilityRole={compact ? "button" : "text"}
      accessibilityLabel={`Context ${percent(share)} full`}
      accessibilityHint={compact ? "Writes /compact in the box" : undefined}
      hitSlop={6}
      className="mt-1.5 flex-row items-center gap-1.5 active:opacity-70"
    >
      <View className="h-1 w-10 overflow-hidden rounded-full bg-border">
        <View
          className={cn("h-1 rounded-full", tone)}
          style={{ width: `${Math.max(4, share * 100)}%` }}
        />
      </View>
      <Text
        className={cn(
          "font-mono text-[11px] text-faint",
          share >= 0.8 && "text-attention",
          share >= 0.95 && "text-destructive",
        )}
      >
        {percent(share)}
      </Text>
    </Pressable>
  );
}

/** What the session has used, as its harness reports it; what it does not say stays out. */
function UsageFacts({ sessionId }: { sessionId: string }) {
  const { chat } = useSession();
  const usage = useSessionUsage(sessionId, chat.live);
  const share = contextShare(usage);
  if (
    !usage ||
    (usage.context_tokens === null &&
      usage.total_tokens === null &&
      usage.cost_usd === null)
  )
    return null;
  return (
    <View className="border-b border-border pb-4">
      {usage.context_tokens !== null ? (
        <Fact label="Context">
          <Text className="font-mono text-sm">
            {tokenCount(usage.context_tokens)}
            {usage.context_window !== null
              ? ` of ${tokenCount(usage.context_window)}`
              : ""}
            {share !== undefined ? ` · ${percent(share)}` : ""}
          </Text>
        </Fact>
      ) : null}
      {usage.total_tokens !== null ? (
        <Fact label="Tokens">
          <Text className="font-mono text-sm">
            {tokenCount(usage.total_tokens)}
          </Text>
        </Fact>
      ) : null}
      {usage.cost_usd !== null ? (
        <Fact label="Cost">
          <Text className="font-mono text-sm">{usdCost(usage.cost_usd)}</Text>
        </Fact>
      ) : null}
    </View>
  );
}

/**
 * Its own title, pinned at the top of the Console, or archived out of it, and the budget
 * that stops its turns once its harness reports that much spent.
 */
function Organize({ session }: { session: ChatSession }) {
  const { chat } = useSession();
  const organize = useOrganize(session);
  const usage = useSessionUsage(session.id, chat.live);
  const [title, setTitle] = useState(session.title);
  const [budget, setBudget] = useState(
    session.budget_usd ? String(session.budget_usd) : "",
  );
  const save = () => {
    if (title.trim() && title.trim() !== session.title) organize.rename(title);
  };
  // A phone in Italian writes 1,50: the comma is the decimal point.
  const saveBudget = () => {
    const usd = budget.trim() ? Number(budget.replace(",", ".")) : 0;
    if (!Number.isFinite(usd) || usd < 0) {
      setBudget(session.budget_usd ? String(session.budget_usd) : "");
      return;
    }
    if (usd !== (session.budget_usd ?? 0)) organize.budget(usd);
  };
  const cost = usage?.cost_usd ?? null;
  const spent =
    session.harness === "codex"
      ? "Codex does not report its cost, so a budget cannot stop it."
      : cost === null
        ? session.budget_usd
          ? "The harness has not reported a cost yet."
          : "No limit. Set one, and the session stops when its cost reaches it."
        : session.budget_usd
          ? `${usdCost(cost)} of ${usdCost(session.budget_usd)}`
          : `${usdCost(cost)} so far, no limit`;
  return (
    <View className="gap-3 border-b border-border pb-4">
      <View className="gap-2">
        <Text className="text-sm text-faint">Title</Text>
        <Input
          value={title}
          onChangeText={setTitle}
          onSubmitEditing={save}
          onBlur={save}
          placeholder="Untitled session"
          returnKeyType="done"
          maxLength={200}
        />
      </View>
      <View className="flex-row items-center gap-3">
        <Text className="flex-1 text-sm">Pinned in the Console</Text>
        <Switch value={organize.pinned} onValueChange={organize.pin} />
      </View>
      <View className="flex-row items-center gap-3">
        <Text className="flex-1 text-sm">Archived</Text>
        <Switch value={organize.archived} onValueChange={organize.archive} />
      </View>
      <View className="gap-2">
        <Text className="text-sm text-faint">Budget</Text>
        {session.harness === "codex" ? null : (
          <View className="flex-row items-center gap-2">
            <Text className="font-mono text-base text-muted-foreground">$</Text>
            <Input
              value={budget}
              onChangeText={setBudget}
              onSubmitEditing={saveBudget}
              onBlur={saveBudget}
              placeholder="No limit"
              keyboardType="decimal-pad"
              returnKeyType="done"
              accessibilityLabel="Budget in dollars"
              className="flex-1 font-mono"
            />
          </View>
        )}
        <Text className="text-xs text-faint">{spent}</Text>
      </View>
    </View>
  );
}
