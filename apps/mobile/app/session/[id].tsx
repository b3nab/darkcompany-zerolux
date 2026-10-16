import { useLocalSearchParams, useRouter } from "expo-router";
import { useEffect, useMemo, useState } from "react";
import {
  ChevronRightIcon,
  PanelRightIcon,
  SendIcon,
  SquareIcon,
} from "lucide-react-native";
import { Modal, Pressable, ScrollView, TextInput, View } from "react-native";
import { KeyboardStickyView } from "react-native-keyboard-controller";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useCSSVariable } from "uniwind";
import {
  draftOf,
  errorMessage,
  folderName,
  harnessLabels,
  saveDraft,
  blockRuns,
  sessionBlocks,
  sessionState,
  sessionTone,
  useArrivals,
  useSessionEvents,
} from "@zerolux/chat";
import type { BlockRun, ChatSession } from "@zerolux/chat";
import { ActorMark, Fact } from "@/components/member";
import { Screen } from "@/components/screen";
import { SessionCard, useInterrupt } from "@/components/session";
import { SessionRunView } from "@/components/session-blocks";
import { ChatList } from "@/components/ui/native";
import { Text } from "@/components/ui/text";
import { cn } from "@/lib/utils";
import { useSession } from "../../src/kernel";
import { useMe } from "../../src/me";

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
  const { events, error, more, earlier } = useSessionEvents(
    id,
    chat.outputs[id]?.end,
  );
  const blocks = useMemo(() => sessionBlocks(events), [events]);
  // Tools run in a row are one list item, as on the web; what arrives live slides in.
  const runs = useMemo(() => blockRuns(blocks), [blocks]);
  const fresh = useArrivals(blocks);
  if (!session)
    return (
      <Screen back title="Session">
        <Text className="px-5 py-6 text-sm text-muted-foreground">
          This session is no longer listed.
        </Text>
      </Screen>
    );
  const agent = workspace?.actors.find((a) => a.id === session.actor_id);
  const name = agent?.name ?? "Agent";
  const chatTitle = (chatId: string) =>
    chat.conversations.find((c) => c.id === chatId)?.title;
  return (
    <Screen
      back
      title={`${name} · ${session.title || "Untitled session"}`}
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
        data={runs}
        keyExtractor={(run) => (run as BlockRun).key}
        renderItem={({ item }) => (
          <SessionRunView
            run={item as BlockRun}
            fresh={fresh}
            chatTitle={chatTitle}
          />
        )}
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
              error ? "text-sm text-destructive" : "text-sm text-faint"
            }
          >
            {error || "Nothing recorded yet."}
          </Text>
        }
      />
      <Composer session={session} name={name} />
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
 * works, Interrupt takes Send's place.
 */
function Composer({ session, name }: { session: ChatSession; name: string }) {
  const insets = useSafeAreaInsets();
  const { chat } = useSession();
  const { owner } = useMe();
  const stop = useInterrupt(session);
  // The unsent text waits in its session while you are elsewhere in the app.
  const [draft, setDraft] = useState(() => draftOf(session.id));
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");
  const [faint, onLamp] = useCSSVariable([
    "--color-faint",
    "--color-primary-foreground",
  ]).map(String);
  useEffect(() => saveDraft(session.id, draft), [session.id, draft]);
  const send = async () => {
    const text = draft.trim();
    if (!text) return;
    setSending(true);
    setError("");
    try {
      await chat.input(session.id, text);
      setDraft("");
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setSending(false);
    }
  };
  const interrupting = !draft.trim() && stop.allowed;
  const shown = error || stop.error;
  if (!owner)
    return (
      <Text
        className="border-t border-border bg-card px-4 pt-3 text-xs text-muted-foreground"
        style={{ paddingBottom: 12 + insets.bottom }}
      >
        Only the workspace's owner writes to a session.
      </Text>
    );
  return (
    <KeyboardStickyView offset={{ closed: 0, opened: insets.bottom }}>
      {shown ? (
        <Text className="bg-card px-3.5 py-1.5 text-sm text-destructive">
          {shown}
        </Text>
      ) : null}
      <View
        className="flex-row items-end gap-1.5 border-t border-border bg-card px-2 pt-2"
        style={{ paddingBottom: 8 + insets.bottom }}
      >
        <View className="min-h-10 flex-1 flex-row items-end rounded-md border border-input bg-background">
          <TextInput
            className="max-h-36 flex-1 px-3 py-2.5 font-sans text-base text-foreground"
            placeholderTextColor={faint}
            placeholder={`Write to ${name}`}
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
              (!draft.trim() || sending) && "opacity-40",
            )}
            disabled={!draft.trim() || sending}
            onPress={() => void send()}
            accessibilityRole="button"
            accessibilityLabel="Send"
          >
            <SendIcon color={onLamp} size={18} strokeWidth={1.75} />
          </Pressable>
        )}
      </View>
    </KeyboardStickyView>
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
        <SessionCard session={session} name={name} facts />
      </ScrollView>
    </View>
  );
}
