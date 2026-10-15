import { useLocalSearchParams, useRouter } from "expo-router";
import { useMemo, useState } from "react";
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
  folderName,
  harnessLabels,
  sessionBlocks,
  sessionState,
  sessionTone,
  useSessionEvents,
} from "@zerolux/chat";
import type { ChatSession, SessionBlock } from "@zerolux/chat";
import { ActorMark, Fact } from "@/components/member";
import { Screen } from "@/components/screen";
import { SessionCard, useInterrupt } from "@/components/session";
import { SessionBlockView } from "@/components/session-blocks";
import { ChatList } from "@/components/ui/native";
import { Text } from "@/components/ui/text";
import { useSession } from "../../src/kernel";

/**
 * One agent session, as the meta-harness apps show it: the agent and its state on top, its
 * work turn by turn in the middle, and below the box to steer it, with Interrupt in place of
 * Send while it works. Details and Stop, Resume, Take over are in About.
 */
export default function SessionPage() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { workspace, chat } = useSession();
  const [about, setAbout] = useState(false);
  const muted = String(useCSSVariable("--color-muted-foreground"));
  const insets = useSafeAreaInsets();
  const session = chat.sessions.find((s) => s.id === id);
  // Read from the start, then again from where it stopped at each session.output notice.
  const { events, error } = useSessionEvents(id, chat.outputs[id]?.end);
  const blocks = useMemo(() => sessionBlocks(events), [events]);
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
        data={blocks}
        keyExtractor={(_, i) => String(i)}
        renderItem={({ item }) => (
          <SessionBlockView
            block={item as SessionBlock}
            chatTitle={chatTitle}
          />
        )}
        contentContainerClassName="gap-3 px-3 pt-3 pb-3"
        alignItemsAtEnd
        initialScrollAtEnd
        maintainScrollAtEnd
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

/** The box to steer the session; while it works, Interrupt takes Send's place. */
function Composer({ session, name }: { session: ChatSession; name: string }) {
  const insets = useSafeAreaInsets();
  const { allowed, busy, error, interrupt } = useInterrupt(session);
  const [faint, onLamp] = useCSSVariable([
    "--color-faint",
    "--color-primary-foreground",
  ]).map(String);
  return (
    <KeyboardStickyView offset={{ closed: 0, opened: insets.bottom }}>
      {error ? (
        <Text className="bg-card px-3.5 py-1.5 text-sm text-destructive">
          {error}
        </Text>
      ) : null}
      <View
        className="flex-row items-end gap-1.5 border-t border-border bg-card px-2 pt-2"
        style={{ paddingBottom: 8 + insets.bottom }}
      >
        <View className="min-h-10 flex-1 flex-row items-end rounded-md border border-input bg-background opacity-60">
          {/* TODO: kernel: a route for the owner's direct input to a session (POST /chat/sessions/{id}/input); then this box sends to it. */}
          <TextInput
            className="max-h-36 flex-1 px-3 py-2.5 font-sans text-base text-foreground"
            placeholderTextColor={faint}
            placeholder={`Writing to ${name} here: not available yet`}
            editable={false}
            multiline
          />
        </View>
        {allowed ? (
          <Pressable
            className="size-10 items-center justify-center rounded-sm bg-primary active:opacity-80"
            disabled={busy}
            onPress={() => void interrupt()}
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
          <View
            className="size-10 items-center justify-center rounded-sm bg-primary opacity-40"
            accessibilityLabel="Send"
            accessibilityState={{ disabled: true }}
          >
            <SendIcon color={onLamp} size={18} strokeWidth={1.75} />
          </View>
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
