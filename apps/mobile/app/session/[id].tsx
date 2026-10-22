import { useFocusEffect, useLocalSearchParams, useRouter } from "expo-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import type { TextInputInstance } from "react-native";
import {
  ActivityIcon,
  ChevronDownIcon,
  ClockIcon,
  PencilIcon,
  ChevronRightIcon,
  FileDiffIcon,
  ListChecksIcon,
  PanelRightIcon,
  PuzzleIcon,
  SquareTerminalIcon,
  XIcon,
} from "lucide-react-native";
import {
  ActionSheetIOS,
  ActivityIndicator,
  Alert,
  AppState,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  Switch,
  TextInput,
  View,
} from "react-native";
import * as Haptics from "expo-haptics";
import Animated, { FadeIn, SlideInDown } from "react-native-reanimated";
import Svg, { Circle } from "react-native-svg";
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
  useBackgroundCommands,
  useSessionSubagents,
  useSessionCompacting,
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
  useUiPieces,
  useVoice,
  useVoiceInput,
  composerAction,
  dictated,
} from "@zerolux/chat";
import type {
  Actor,
  AgentSettings,
  ComposerAction,
  Subagent,
  Approval,
  ApprovalItem,
  BlockRun,
  ChatSession,
  Density,
  InputMode,
  LiveItem,
  QueuedInput,
  SentInput,
  SessionUsage,
  PlanStep,
  SessionBlock,
} from "@zerolux/chat";
import { ApprovalCard, ApprovalReceipt } from "@/components/approval-card";
import { Composer as ComposerBox } from "@/components/composer";
import { pieceIcon } from "@/components/extension-view";
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
import { Eyebrow } from "@/components/meter";
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
import { ToLatest, useAway } from "@/components/to-latest";
import { Text } from "@/components/ui/text";
import { cn } from "@/lib/utils";
import { setDensity, useDensity } from "../../src/density";
import { useSession } from "../../src/kernel";
import { useAccess } from "../../src/me";
import { dismissNotice } from "../../src/notices";
import { pickPhotos } from "../../src/photos";
import type { Photo } from "../../src/photos";
import { useRecorder } from "../../src/voice";

/** What the stream lists: the session's own blocks and the requests it made. */
type Item = SessionBlock | ApprovalItem;
/** What it is producing now, after the record's work. */
type LiveRow = { kind: "live"; key: string; item: LiveItem };
type SentRow = { kind: "sent"; key: string; input: SentInput };
type Row = BlockRun<Item> | LiveRow | SentRow;
/** Where in the native record a row's work is: its blocks are keyed by it. */
const rowAt = (row: Row) =>
  row.kind === "live" || row.kind === "sent" || row.kind === "approval"
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
  // How many of its background commands run now, on the Background button.
  const running =
    useBackgroundCommands(access.read ? id : undefined, url).commands?.filter(
      (command) => command.status === "running",
    ).length ?? 0;
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
  // What the owner sent shows at once, until the record or the queue has it.
  const queue = useSessionQueue(id, chat.live);
  const sent = chat.sentInputs(id, blocks, queue);
  const rows: Row[] = [
    ...runs,
    ...live.map((item) => ({
      kind: "live" as const,
      key: `live:${item.id}`,
      item,
    })),
    ...sent.map((input) => ({
      kind: "sent" as const,
      key: `sent:${input.id}`,
      input,
    })),
  ];
  const fresh = useArrivals(items);
  // Opened at a place in its history: earlier work is read until it is in, then shown once.
  const list = useRef<LegendListRef>(null);
  const { away, onScroll } = useAway();
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
    if (events[0]!.at > target && more) return void earlier();
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
          {access.read ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={
                running ? `Background, ${running} running` : "Background"
              }
              onPress={() => router.push(`/background/${id}`)}
              hitSlop={6}
              className="size-10 items-center justify-center rounded-sm active:bg-accent"
            >
              <ActivityIcon color={muted} size={20} strokeWidth={1.5} />
              {running ? (
                <View className="absolute top-0.5 right-0 min-w-4 items-center rounded-full bg-success px-1">
                  <Text className="font-mono text-[10px] leading-4 text-primary-foreground">
                    {running}
                  </Text>
                </View>
              ) : null}
            </Pressable>
          ) : null}
          {access.read ? <SessionPieces session={id} /> : null}
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
        <View className="flex-1">
          <ChatList
            ref={list}
            data={rows}
            extraData={drawn}
            keyExtractor={(row) => (row as Row).key}
            renderItem={({ item }) =>
              (item as Row).kind === "live" ? (
                <LiveItemView item={(item as LiveRow).item} />
              ) : (item as Row).kind === "sent" ? (
                <SentInputView input={(item as SentRow).input} />
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
            onScroll={onScroll}
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
          <ToLatest list={list} shown={away} label="Back to the latest work" />
        </View>
      </SubagentLinks>
      <Composer
        session={session}
        name={name}
        notice={error}
        recordEnd={(events.at(-1)?.at ?? -1) + 1}
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
 * turn when it is idle, or joining the turn it is working on; held, Send waits for the turn
 * or stops it first. `/compact` runs the harness's own compaction, "/" offers the commands
 * and "@" the files. What stays above it while the session works, as its plan, comes as
 * children.
 */
function Composer({
  session,
  name,
  notice,
  recordEnd,
  children,
}: {
  session: ChatSession;
  name: string;
  notice: string;
  /** Where the record shown ends: what is sent now comes after. */
  recordEnd: number;
  children?: ReactNode;
}) {
  const insets = useSafeAreaInsets();
  const { chat, url } = useSession();
  const { write } = useAccess(session);
  const stop = useInterrupt(session);
  const harnessCommands = useSessionCommands(session.id, url);
  const queue = useSessionQueue(session.id, chat.live);
  const usage = useSessionUsage(session.id, chat.live);
  // Shown for every compaction, whoever started it, until its summary or failure.
  const compacting = useSessionCompacting(session.id, chat.live);
  const settings = useSessionSettings(
    session.id,
    `${session.status}:${session.activity}`,
    url,
  );
  const { available: transcription } = useVoice(url);
  // The unsent text waits in its session while you are elsewhere in the app.
  const [draft, setDraft] = useState(() => draftOf(session.id));
  const box = useRef<TextInputInstance>(null);
  const [cursor, setCursor] = useState(draft.length);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");
  // Photos go with the words, or alone; they wait in the box until sent.
  const [photos, setPhotos] = useState<Photo[]>([]);
  const [picking, setPicking] = useState(false);
  const [sheet, setSheet] = useState(false);
  const agent = String(useCSSVariable("--color-agent"));
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
  const recorder = useRecorder();
  const voice = useVoiceInput(
    recorder,
    {
      write: (said) => setDraft((now) => dictated(now, said)),
      // The session takes words: what was said goes as the input, shown at once.
      send: async (said) =>
        void chat
          .input(session.id, said, undefined, [], recordEnd)
          .catch(() => undefined),
      transcription,
    },
    url,
  );
  const compact = async (args?: string) => {
    setSending(true);
    setError("");
    try {
      await chat.compact(session.id, args);
      return true;
    } catch (e) {
      setError(errorMessage(e));
      return false;
    } finally {
      setSending(false);
    }
  };
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
    setError("");
    // What was typed or picked meanwhile stays.
    const clear = () => {
      setDraft((now) => (now === text ? "" : now));
      setPhotos((now) => now.filter((photo) => !sent.includes(photo)));
    };
    if (command?.name !== "compact") {
      // It shows at once at the session's end; a failure stays there, to send again.
      clear();
      return void chat
        .input(
          session.id,
          text.trim(),
          mode,
          sent.map(({ media_type, data }) => ({ media_type, data })),
          recordEnd,
        )
        .catch(() => undefined);
    }
    if (await compact(command.args)) clear();
  };
  // Claude Code in a terminal only takes words, into the running turn.
  const choosable = !(
    session.harness === "claude-code" && session.origin !== "owned"
  );
  const filled = Boolean(draft.trim() || photos.length);
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
      Alert.alert("Add a photo", undefined, [
        { text: "Photo library", onPress: () => pick("library") },
        { text: "Take photo", onPress: () => pick("camera") },
        { text: "Cancel", style: "cancel" },
      ]);
  };
  const modes: [string, InputMode][] = [
    ["When the turn ends", "queue"],
    ["Stop and send", "interrupt"],
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
  const action = composerAction({
    filled,
    interruptible: stop.allowed,
    recordable: transcription && open,
    voice: voice.use,
    transcribing: voice.transcribing,
  });
  // Record, and ending a recording, are the composer's own: here Send and Interrupt.
  const act = (now: ComposerAction) =>
    void (now === "interrupt" ? stop.interrupt() : send());
  const above = (
    <>
      {children}
      {compacting ? (
        <View className="flex-row items-center gap-2 px-1.5">
          <ActivityIndicator
            size="small"
            color={agent}
            style={{ transform: [{ scale: 0.7 }] }}
          />
          <Text className="flex-1 text-xs text-muted-foreground">
            Compacting…
          </Text>
        </View>
      ) : null}
      {queue.map((item) => (
        <QueueCard
          key={item.id}
          session={session}
          item={item}
          changeable={write && item.changeable}
        />
      ))}
      {mention && files.length ? (
        <View className="max-h-56 overflow-hidden rounded-lg border border-border bg-popover">
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
        <View className="overflow-hidden rounded-lg border border-border bg-popover">
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
    </>
  );
  if (!write)
    return (
      <View
        className="gap-2 px-2.5 pt-2"
        style={{ paddingBottom: 8 + insets.bottom }}
      >
        {above}
        <Text className="px-1.5 pb-1 text-xs text-muted-foreground">
          Shared with you to read
        </Text>
      </View>
    );
  return (
    <>
      <ComposerBox
        above={above}
        error={notice || error || stop.error || voice.error}
        chips={photos.map((photo, i) => ({
          key: photo.uri,
          uri: photo.uri,
          name: `photo ${i + 1}`,
          image: true,
        }))}
        removeChip={(key) =>
          setPhotos((now) => now.filter((photo) => photo.uri !== key))
        }
        inputRef={box}
        input={{
          value: draft,
          onChangeText: setDraft,
          editable: open,
          onSelectionChange: (event) =>
            setCursor(event.nativeEvent.selection.start),
          placeholder: open
            ? stop.allowed
              ? `Add to ${name}'s turn`
              : `Write to ${name}, or / for commands`
            : sessionState(session),
        }}
        add={
          choosable
            ? { onPress: attach, busy: picking, disabled: !open || room <= 0 }
            : undefined
        }
        middle={
          session.status !== "stopped" ? (
            <SettingsPill
              session={session}
              settings={settings}
              onPress={() => setSheet(true)}
            />
          ) : null
        }
        trailing={<ContextRing usage={usage} onPress={() => setSheet(true)} />}
        voice={{
          use: voice.use,
          transcribing: voice.transcribing,
          seconds: recorder.seconds,
          level: recorder.level,
          dictation: transcription && open,
          press: voice.press,
          release: voice.release,
          discard: voice.discard,
        }}
        action={action}
        onAction={act}
        onHold={
          action === "send" && !voice.use && stop.allowed && open && choosable
            ? chooseMode
            : undefined
        }
        waiting={
          action === "interrupt"
            ? stop.busy
            : action === "record"
              ? !open
              : action === "send" && !voice.use && (!open || !filled || sending)
        }
      />
      <SessionSheet
        visible={sheet}
        close={() => setSheet(false)}
        session={session}
        settings={settings}
        usage={usage}
        compact={
          open
            ? () => {
                setSheet(false);
                void compact();
              }
            : undefined
        }
      />
    </>
  );
}

/**
 * In the session's header, its extensions' panels: one opens at once, several ask which.
 */
function SessionPieces({ session }: { session: string }) {
  const { url } = useSession();
  const router = useRouter();
  const pieces = useUiPieces("session", url);
  const muted = String(useCSSVariable("--color-muted-foreground"));
  if (!pieces.length) return null;
  const open = (index: number) => {
    const piece = pieces[index];
    if (!piece) return;
    router.push({
      pathname: "/piece",
      params: {
        extension: piece.extension,
        name: piece.name,
        space: "session",
        session,
      },
    });
  };
  const choose = () => {
    if (pieces.length === 1) return open(0);
    const titles = pieces.map((piece) => piece.title);
    if (Platform.OS === "ios")
      return ActionSheetIOS.showActionSheetWithOptions(
        { options: [...titles, "Cancel"], cancelButtonIndex: titles.length },
        open,
      );
    Alert.alert("Extensions", undefined, [
      ...titles.map((text, i) => ({ text, onPress: () => open(i) })),
      { text: "Cancel", style: "cancel" as const },
    ]);
  };
  const Icon = pieces.length === 1 ? pieceIcon(pieces[0]!) : PuzzleIcon;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={pieces.length === 1 ? pieces[0]!.title : "Extensions"}
      onPress={choose}
      hitSlop={6}
      className="size-10 items-center justify-center rounded-sm active:bg-accent"
    >
      <Icon color={muted} size={20} strokeWidth={1.5} />
    </Pressable>
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
      <ScrollView contentContainerClassName="gap-8 px-5 py-6">
        <View className="gap-5">
          <Eyebrow>Session</Eyebrow>
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
          <SessionCard session={session} name={name} facts />
          {access.mine ? <Organize session={session} /> : null}
          <UsageFacts sessionId={session.id} />
          {access.mine ? <Budget session={session} /> : null}
          <SubagentList
            sessionId={session.id}
            subagents={subagents}
            close={close}
          />
          <Delegation session={session} close={close} />
          <ForkSession session={session} close={close} />
          <ContinueInTerminal session={session} />
          <View className="gap-2">
            <Text className="text-sm text-faint">Density</Text>
            <Segmented<Density>
              options={Object.entries(densityLabels) as [Density, string][]}
              value={density}
              choose={setDensity}
            />
          </View>
        </View>
        <View className="gap-5">
          <Eyebrow>Sharing</Eyebrow>
          <Sharing session={session} />
        </View>
        <View className="gap-5">
          <Eyebrow>Automations</Eyebrow>
          <GoalSection session={session} />
          <Schedules session={session} />
          <CiTrigger session={session} />
        </View>
      </ScrollView>
    </View>
  );
}

type Settings = ReturnType<typeof useSessionSettings>;

/** The session's settings as the box shows them: model, effort and Plan; tapped, the sheet. */
function SettingsPill({
  session,
  settings,
  onPress,
}: {
  session: ChatSession;
  settings: Settings;
  onPress: () => void;
}) {
  const [agent, muted] = useCSSVariable([
    "--color-agent",
    "--color-muted-foreground",
  ]).map(String);
  if (!settings.data?.editable.length) return null;
  const harness = session.harness as Actor["harness"];
  const { values, models, editable } = settings.data;
  const fields = agentSettingFields(harness, models, values.model);
  const plan = planMode(harness, values, editable);
  const named = (key: "model" | "effort") => {
    const value = values[key];
    return value
      ? (fields.find((field) => field.key === key)?.options[value] ?? value)
      : undefined;
  };
  const effort = named("effort");
  return (
    <Pressable
      onPress={() => {
        void Haptics.selectionAsync();
        onPress();
      }}
      accessibilityRole="button"
      accessibilityLabel="Session settings"
      className="ml-1 h-8 min-w-0 shrink flex-row items-center gap-1.5 rounded-md bg-muted px-2.5 active:opacity-70"
    >
      <Text numberOfLines={1} className="shrink text-[13px] font-medium">
        {named("model") ?? "Model"}
      </Text>
      {effort ? (
        <Text
          numberOfLines={1}
          className="shrink-0 text-[13px] text-muted-foreground"
        >
          · {effort}
        </Text>
      ) : null}
      {plan?.on ? (
        <>
          <Text className="text-[13px] text-faint">·</Text>
          <ListChecksIcon color={agent} size={13} strokeWidth={1.75} />
          <Text className="text-[13px] text-agent-foreground">Plan</Text>
        </>
      ) : null}
      <ChevronDownIcon color={muted} size={14} strokeWidth={2} />
    </Pressable>
  );
}

/**
 * The session's model, effort, permissions and Plan, changed one at a time through its
 * harness, which confirms it or says why not; and how full its context is, with Compact.
 */
function SessionSheet({
  visible,
  close,
  session,
  settings,
  usage,
  compact,
}: {
  visible: boolean;
  close: () => void;
  session: ChatSession;
  settings: Settings;
  usage: SessionUsage | null;
  compact?: () => void;
}) {
  const insets = useSafeAreaInsets();
  const [error, setError] = useState("");
  const harness = session.harness as Actor["harness"];
  const values = settings.data?.values ?? {};
  const editable = settings.data?.editable ?? [];
  const fields = agentSettingFields(
    harness,
    settings.data?.models ?? [],
    values.model,
  );
  const plan = planMode(harness, values, editable);
  const share = contextShare(usage);
  const apply = (change: AgentSettings) => {
    setError("");
    settings.apply(change).catch((e: unknown) => setError(errorMessage(e)));
  };
  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={close}
    >
      <Pressable
        className="flex-1 bg-black/40"
        onPress={close}
        accessibilityRole="button"
        accessibilityLabel="Close"
      />
      <Animated.View
        entering={SlideInDown.duration(240)}
        accessibilityViewIsModal
        className="gap-4 rounded-t-[22px] bg-popover px-5 pt-2"
        style={{ paddingBottom: insets.bottom + 16 }}
      >
        <View className="h-1.5 w-10 self-center rounded-full bg-input" />
        <View className="flex-row items-center justify-between">
          <Text accessibilityRole="header" className="text-lg font-semibold">
            Session
          </Text>
          <Pressable onPress={close} accessibilityRole="button" hitSlop={8}>
            <Text className="text-base font-medium text-human-foreground">
              Done
            </Text>
          </Pressable>
        </View>
        {editable.length
          ? fields.map(({ key, label, options }) => (
              <SettingSelect
                key={key}
                label={label}
                value={values[key] ?? ""}
                options={options}
                disabled={
                  !editable.includes(key) || Object.keys(options).length === 0
                }
                onChange={(value) => apply({ [key]: value })}
              />
            ))
          : null}
        {plan ? (
          <View className="flex-row items-center justify-between">
            <Text className="text-sm font-medium">Plan</Text>
            <Switch
              value={plan.on}
              onValueChange={(on) => apply(plan.change(on))}
              accessibilityLabel="Plan"
            />
          </View>
        ) : null}
        {share !== undefined && usage ? (
          <View className="gap-2">
            <Text className="text-sm font-medium">Context</Text>
            <View className="h-1.5 overflow-hidden rounded-full bg-muted">
              <View
                className={cn("h-1.5 rounded-full", contextTone(share))}
                style={{ width: `${Math.max(3, share * 100)}%` }}
              />
            </View>
            <View className="flex-row items-center justify-between">
              <Text className="font-mono text-xs text-muted-foreground">
                {percent(share)}
                {usage.context_tokens !== null && usage.context_window
                  ? ` · ${tokenCount(usage.context_tokens)} of ${tokenCount(usage.context_window)}`
                  : ""}
              </Text>
              {compact ? (
                <Button size="sm" variant="outline" onPress={compact}>
                  <Text>Compact</Text>
                </Button>
              ) : null}
            </View>
          </View>
        ) : null}
        {error || settings.error ? (
          <Text className="text-sm text-attention">
            {error || settings.error}
          </Text>
        ) : null}
      </Animated.View>
    </Modal>
  );
}

/** An input of the owner's on its way: sending, sent, or failed with its error and Retry. */
function SentInputView({ input }: { input: SentInput }) {
  const { chat } = useSession();
  const photos = input.images.length;
  return (
    <View className="max-w-[86%] gap-1 self-end rounded-md rounded-br-xs border border-human/25 bg-human/10 px-3 py-2">
      {input.text ? (
        <Text className="text-[15px] leading-[21px]">{input.text}</Text>
      ) : null}
      {photos ? (
        <Text className="text-xs text-muted-foreground">
          {photos === 1 ? "1 photo" : `${photos} photos`}
        </Text>
      ) : null}
      {input.status === "failed" ? (
        <View className="gap-1.5">
          <Text className="text-xs text-destructive">{input.error}</Text>
          <View className="flex-row gap-4 self-end">
            <Pressable
              accessibilityRole="button"
              onPress={() => chat.dropInput(input.id)}
              hitSlop={8}
            >
              <Text className="text-[13px] font-medium text-muted-foreground">
                Discard
              </Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              onPress={() =>
                void chat.retryInput(input.id).catch(() => undefined)
              }
              hitSlop={8}
            >
              <Text className="text-[13px] font-medium text-human-foreground">
                Retry
              </Text>
            </Pressable>
          </View>
        </View>
      ) : (
        <Text className="self-end font-mono text-[11px] text-faint">
          {input.status === "sending" ? "Sending…" : "Sent"}
        </Text>
      )}
    </View>
  );
}

/**
 * An input of the owner's waiting for the turn to end, above the box: rewritten or taken
 * back where its harness allows it.
 */
function QueueCard({
  session,
  item,
  changeable,
}: {
  session: ChatSession;
  item: QueuedInput;
  changeable: boolean;
}) {
  const { chat } = useSession();
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
        {changeable && editing === undefined ? (
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

const contextTone = (share: number) =>
  share >= 0.95 ? "bg-destructive" : share >= 0.8 ? "bg-attention" : "bg-agent";

/** How full the session's context is, as its harness last said: a ring that warms as it fills. */
function ContextRing({
  usage,
  onPress,
}: {
  usage: SessionUsage | null;
  onPress: () => void;
}) {
  const [track, agent, attention, destructive] = useCSSVariable([
    "--color-input",
    "--color-agent",
    "--color-attention",
    "--color-destructive",
  ]).map(String);
  const share = contextShare(usage);
  if (share === undefined) return null;
  const tone = share >= 0.95 ? destructive : share >= 0.8 ? attention : agent;
  const round = 2 * Math.PI * 7.5;
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`Context ${percent(share)} full`}
      hitSlop={4}
      className="h-10 flex-row items-center gap-1 px-1 active:opacity-70"
    >
      <Text
        className={cn(
          "font-mono text-[11px] text-faint",
          share >= 0.8 && "text-attention",
          share >= 0.95 && "text-destructive",
        )}
      >
        {percent(share)}
      </Text>
      <Svg
        width={20}
        height={20}
        viewBox="0 0 20 20"
        style={{ transform: [{ rotate: "-90deg" }] }}
      >
        <Circle
          cx={10}
          cy={10}
          r={7.5}
          stroke={track}
          strokeWidth={3}
          fill="none"
        />
        <Circle
          cx={10}
          cy={10}
          r={7.5}
          stroke={tone}
          strokeWidth={3}
          fill="none"
          strokeLinecap="round"
          strokeDasharray={`${round * Math.max(share, 0.03)} ${round}`}
        />
      </Svg>
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
  const organize = useOrganize(session);
  const [title, setTitle] = useState(session.title);
  const save = () => {
    if (title.trim() && title.trim() !== session.title) organize.rename(title);
  };
  return (
    <View className="gap-3">
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
    </View>
  );
}

/** What the session may spend, and what it has spent, as its harness reports it. */
function Budget({ session }: { session: ChatSession }) {
  const { chat } = useSession();
  const organize = useOrganize(session);
  const usage = useSessionUsage(session.id, chat.live);
  const [budget, setBudget] = useState(
    session.budget_usd ? String(session.budget_usd) : "",
  );
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
      ? "Codex reports no cost"
      : cost === null
        ? session.budget_usd
          ? "No cost reported yet"
          : "No limit"
        : session.budget_usd
          ? `${usdCost(cost)} of ${usdCost(session.budget_usd)}`
          : `${usdCost(cost)} so far, no limit`;
  return (
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
  );
}
