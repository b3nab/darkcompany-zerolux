import { useFocusEffect, useLocalSearchParams, useRouter } from "expo-router";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import {
  ChevronDownIcon,
  ImagePlusIcon,
  ChevronRightIcon,
  ListChecksIcon,
  PanelRightIcon,
  SendIcon,
  SquareIcon,
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
  useSessionCommands,
  useSessionEvents,
  useSessionLive,
  useSessionSettings,
} from "@zerolux/chat";
import type {
  Actor,
  Approval,
  ApprovalItem,
  BlockRun,
  ChatSession,
  Density,
  InputMode,
  LiveItem,
  PlanStep,
  SessionBlock,
} from "@zerolux/chat";
import { ApprovalCard, ApprovalReceipt } from "@/components/approval-card";
import { ActorMark, Fact } from "@/components/member";
import { Screen } from "@/components/screen";
import { Segmented } from "@/components/segmented";
import { SessionCard, useInterrupt, useOrganize } from "@/components/session";
import { SettingSelect } from "@/components/setting-select";
import { Input } from "@/components/ui/input";
import { LiveItemView, SessionRunView } from "@/components/session-blocks";
import { PlanSteps } from "@/components/tool-call";
import { ChatList } from "@/components/ui/native";
import { Text } from "@/components/ui/text";
import { cn } from "@/lib/utils";
import { setDensity, useDensity } from "../../src/density";
import { useSession } from "../../src/kernel";
import { useMe } from "../../src/me";
import { dismissNotice } from "../../src/notices";
import { pickPhotos } from "../../src/photos";
import type { Photo } from "../../src/photos";

/** What the stream lists: the session's own blocks and the requests it made. */
type Item = SessionBlock | ApprovalItem;
/** What it is producing now, after the record's work. */
type LiveRow = { kind: "live"; key: string; item: LiveItem };
type Row = BlockRun<Item> | LiveRow;

/**
 * One agent session, as the meta-harness apps show it: the agent and its state on top, its
 * work turn by turn in the middle, and below the box to write to it, with Interrupt in place
 * of Send while it works. Details and Stop, Resume, Take over are in About.
 */
export default function SessionPage() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { workspace, chat } = useSession();
  const [about, setAbout] = useState(false);
  const muted = String(useCSSVariable("--color-muted-foreground"));
  const insets = useSafeAreaInsets();
  const session = chat.sessions.find((s) => s.id === id);
  // Read from the start, then again from where it stopped at each session.output notice.
  const {
    events,
    error: readError,
    more,
    earlier,
  } = useSessionEvents(id, chat.outputs[id]?.end);
  const blocks = useMemo(() => sessionBlocks(events), [events]);
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
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="About this session"
          onPress={() => setAbout(true)}
          hitSlop={6}
          className="size-10 items-center justify-center rounded-sm active:bg-accent"
        >
          <PanelRightIcon color={muted} size={20} strokeWidth={1.5} />
        </Pressable>
      }
    >
      <ChatList
        data={rows}
        keyExtractor={(row) => (row as Row).key}
        renderItem={({ item }) =>
          (item as Row).kind === "live" ? (
            <LiveItemView item={(item as LiveRow).item} />
          ) : (
            <SessionRunView
              run={item as BlockRun<Item>}
              fresh={fresh}
              chatTitle={chatTitle}
              renderApproval={(approval: Approval) =>
                approval.status === "pending" ? (
                  <ApprovalCard
                    approval={approval}
                    agent={name}
                    busy={busy}
                    decide={(decision) =>
                      void act(() => chat.decide(approval.id, decision))
                    }
                    answer={(answer) =>
                      void act(() => chat.answer(approval.id, answer))
                    }
                  />
                ) : (
                  <ApprovalReceipt approval={approval} />
                )
              }
            />
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
      <Modal
        visible={about}
        animationType="slide"
        presentationStyle="pageSheet"
        onRequestClose={() => setAbout(false)}
      >
        <About
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
  const { owner } = useMe();
  const stop = useInterrupt(session);
  const harnessCommands = useSessionCommands(session.id, url);
  // The unsent text waits in its session while you are elsewhere in the app.
  const [draft, setDraft] = useState(() => draftOf(session.id));
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
  useEffect(() => saveDraft(session.id, draft), [session.id, draft]);
  const open = owner && session.status === "connected";
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
  // Claude Code in a terminal only takes words into the running turn.
  const choosable = !(
    session.harness === "claude-code" && session.origin !== "owned"
  );
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
        {owner ? (
          <View className="flex-row items-end gap-1.5">
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
                editable={open}
                value={draft}
                onChangeText={setDraft}
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
            Only the workspace's owner writes to a session.
          </Text>
        )}
        {owner && stop.allowed && filled && !sessionCommand(draft) ? (
          <Text className="px-1.5 text-xs text-faint">
            {choosable
              ? "Joins the turn in progress. Hold Send to send it when the turn ends, or to stop the turn and send."
              : "Joins the turn in progress."}
          </Text>
        ) : null}
        {owner && session.status !== "stopped" ? (
          <SettingsBar session={session} />
        ) : null}
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
  session,
  agentId,
  name,
  close,
}: {
  session: ChatSession;
  agentId?: string;
  name: string;
  close: () => void;
}) {
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
        <Organize session={session} />
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
  const fields = agentSettingFields(
    session.harness as Actor["harness"],
    models,
    values.model,
  );
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
            onChange={(value) => {
              setError("");
              settings
                .apply({ [key]: value })
                .catch((e: unknown) => setError(errorMessage(e)));
            }}
          />
        ))}
      </View>
      {error || settings.error ? (
        <Text className="text-xs text-attention">
          {error || settings.error}
        </Text>
      ) : null}
    </View>
  );
}

/** Its own title, pinned at the top of the Console, or archived out of it. */
function Organize({ session }: { session: ChatSession }) {
  const organize = useOrganize(session);
  const [title, setTitle] = useState(session.title);
  const save = () => {
    if (title.trim() && title.trim() !== session.title) organize.rename(title);
  };
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
    </View>
  );
}
