import { useLocalSearchParams, useRouter } from "expo-router";
import { useMemo, useRef, useState } from "react";
import { View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { LegendListRef } from "@legendapp/list/react-native";
import {
  blockRuns,
  composerAction,
  errorMessage,
  folderName,
  harnessLabels,
  placeApprovals,
  sessionBlocks,
  useArrivals,
  useSessionEvents,
} from "@zerolux/chat";
import type { BlockRun, Harness } from "@zerolux/chat";
import { Composer } from "@/components/composer";
import { ActorMark } from "@/components/member";
import { Screen } from "@/components/screen";
import { SessionRunView } from "@/components/session-blocks";
import { ToolRecord } from "@/components/tool-call";
import { ToLatest, useAway } from "@/components/to-latest";
import { ChatList } from "@/components/ui/native";
import { Text } from "@/components/ui/text";
import { useSession } from "../../src/kernel";

/** Nothing records here: words are written, not said. */
const silent = {
  transcribing: false,
  seconds: 0,
  dictation: false,
  level: () => 0,
  press: () => {},
  release: () => {},
  discard: () => {},
};

/**
 * A native session of the project, not in the workspace yet: its record, read where its
 * harness keeps it without opening it, followed while it grows. The first words written bring
 * it into the workspace as your own and go on in it there.
 */
export default function NativeSession() {
  const { id, title, harness, folder } = useLocalSearchParams<{
    id: string;
    title?: string;
    harness?: Harness;
    folder?: string;
  }>();
  const { chat } = useSession();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const {
    events,
    error: readError,
    more,
    earlier,
  } = useSessionEvents(id, undefined, undefined, true);
  const items = useMemo(
    () => placeApprovals(sessionBlocks(events), []),
    [events],
  );
  const runs = useMemo(() => blockRuns(items), [items]);
  // A tool's output a page carried cut is read whole from where the harness keeps it.
  const record = useMemo(() => ({ sessionId: id, native: true }), [id]);
  const fresh = useArrivals(items);
  const list = useRef<LegendListRef>(null);
  const { away, onScroll } = useAway();
  const name = title || "Untitled session";
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");

  async function send() {
    const text = draft.trim();
    if (!text || sending) return;
    setSending(true);
    setError("");
    try {
      const session = await chat.continueNative(
        id,
        text,
        [],
        (events.at(-1)?.at ?? -1) + 1,
      );
      router.replace(`/session/${session.id}`);
    } catch (e) {
      setError(errorMessage(e));
      setSending(false);
    }
  }

  return (
    <Screen
      back
      title={name}
      subtitle={[
        harness && (harnessLabels[harness] ?? harness),
        folder && folderName(folder),
      ]
        .filter(Boolean)
        .join(" · ")}
      leading={<ActorMark kind="agent" name={name} tone="stopped" size="sm" />}
    >
      <ToolRecord value={record}>
        <View className="flex-1">
          <ChatList
            ref={list}
            data={runs}
            keyExtractor={(run) =>
              (run as BlockRun<(typeof items)[number]>).key
            }
            renderItem={({ item }) => (
              <SessionRunView
                run={item as BlockRun<(typeof items)[number]>}
                fresh={fresh}
              />
            )}
            contentContainerClassName="gap-3 px-3 pt-3 pb-3"
            alignItemsAtEnd
            initialScrollAtEnd
            maintainScrollAtEnd
            maintainVisibleContentPosition={{ data: true, size: true }}
            // The latest work comes first; earlier work is read two screens before the top, so
            // scrolling up rarely waits for it.
            onStartReached={more ? earlier : undefined}
            onStartReachedThreshold={2}
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
      </ToolRecord>
      <Composer
        error={error}
        input={{
          value: draft,
          onChangeText: setDraft,
          editable: !sending,
          placeholder: `Continue ${name}`,
        }}
        voice={silent}
        action={composerAction({
          filled: Boolean(draft.trim()),
          interruptible: false,
          recordable: false,
          transcribing: false,
        })}
        onAction={() => void send()}
        waiting={!draft.trim() || sending}
      />
    </Screen>
  );
}
