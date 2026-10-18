import * as Clipboard from "expo-clipboard";
import * as Haptics from "expo-haptics";
import { useRouter } from "expo-router";
import { useState } from "react";
import {
  ActionSheetIOS,
  Alert,
  Modal,
  Platform,
  Pressable,
  TextInput,
  View,
} from "react-native";
import { errorMessage, saveDraft } from "@zerolux/chat";
import type {
  ChatSession,
  FilesRewind,
  SessionBlock,
  SessionFork,
} from "@zerolux/chat";
import { useCSSVariable } from "uniwind";
import { Button } from "@/components/ui/button";
import { Text } from "@/components/ui/text";
import { useSession } from "../src/kernel";
import { useAccess } from "../src/me";

export type InputBlock = Extract<SessionBlock, { kind: "input" }>;

/** What a rewind changes, as one line: how many files, lines added and removed. */
const changes = (rewind: FilesRewind) => {
  const files = rewind.filesChanged?.length ?? 0;
  return `${files} ${files === 1 ? "file" : "files"}, +${rewind.insertions ?? 0} -${rewind.deletions ?? 0}`;
};

/** The files themselves, the first few. */
const fileList = (rewind: FilesRewind) => {
  const files = rewind.filesChanged ?? [];
  const more = files.length - 8;
  return [...files.slice(0, 8), ...(more > 0 ? [`and ${more} more`] : [])].join(
    "\n",
  );
};

/**
 * What the owner does with one of their inputs, on a long press: resend it, edited, in a new
 * session that goes on from before it, this one staying as it is; put the folder's files back
 * as they were before it, where the harness keeps checkpoints; or copy it. `open` shows the
 * choices; `sheet` is the editor, to render once.
 */
export function useInputActions(session: ChatSession | undefined) {
  const { chat } = useSession();
  // A fork is its person's; putting files back is working in it; both stay off a joined
  // computer so far. Copying is reading.
  const { mine, write, here } = useAccess(session);
  const router = useRouter();
  const forkWith = useForkWith();
  const [editing, setEditing] = useState<{ block: InputBlock; text: string }>();
  const failed = (title: string) => (e: unknown) =>
    Alert.alert(title, errorMessage(e));
  const rewind = async (session: ChatSession, block: InputBlock) => {
    const plan = await chat.rewindFiles(session.id, block.at, true);
    if (!plan.canRewind)
      return Alert.alert(
        "The files can't be put back",
        plan.error ?? "Claude Code has no checkpoint before this message.",
      );
    if (!plan.filesChanged?.length)
      return Alert.alert(
        "Nothing to put back",
        "The files are as they were before this message.",
      );
    Alert.alert(
      "Put the files back?",
      `As they were before this message: ${changes(plan)}.\n\n${fileList(plan)}`,
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Put back",
          style: "destructive",
          onPress: () =>
            void chat
              .rewindFiles(session.id, block.at)
              .then((done) =>
                done.canRewind
                  ? void Haptics.notificationAsync(
                      Haptics.NotificationFeedbackType.Success,
                    )
                  : Alert.alert(
                      "The files can't be put back",
                      done.error ?? "Claude Code did not say why.",
                    ),
              )
              .catch(failed("The files can't be put back")),
        },
      ],
    );
  };
  const open = (block: InputBlock) => {
    if (!session) return;
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    const actions = [
      ...(mine && here
        ? [
            {
              label: "Edit and resend",
              run: () => setEditing({ block, text: block.text }),
            },
          ]
        : []),
      // Only Claude Code keeps checkpoints; the others' files come back through their changes.
      ...(write && here && session.harness === "claude-code"
        ? [
            {
              label: "Put files back to before this",
              run: () =>
                void rewind(session, block).catch(
                  failed("The files can't be put back"),
                ),
            },
          ]
        : []),
      {
        label: "Copy",
        run: () => void Clipboard.setStringAsync(block.text),
      },
    ];
    if (Platform.OS === "ios")
      ActionSheetIOS.showActionSheetWithOptions(
        {
          options: [...actions.map((a) => a.label), "Cancel"],
          cancelButtonIndex: actions.length,
        },
        (index) => actions[index]?.run(),
      );
    // Android's alert has three buttons at most: outside it is Cancel.
    else
      Alert.alert(
        "Your message",
        undefined,
        actions.map((a) => ({ text: a.label, onPress: a.run })),
        { cancelable: true },
      );
  };
  const sheet = (
    <ForkEditor
      title="Edit and resend"
      caption="A new session goes on from before this message, with your new words. This one stays as it is."
      text={editing?.text}
      setText={(text) =>
        setEditing((current) => current && { ...current, text })
      }
      send={async (text) => {
        const id = await forkWith(session!, { at: editing!.block.at }, text);
        setEditing(undefined);
        router.push(`/session/${id}`);
      }}
      close={() => setEditing(undefined)}
    />
  );
  return { open, sheet };
}

/**
 * A fork that starts with the owner's words: it is opened once they are in, and words it did
 * not take wait in its box. Its ID.
 */
function useForkWith() {
  const { chat } = useSession();
  return async (session: ChatSession, fork: SessionFork, text: string) => {
    const { session: forked } = await chat.forkSession(session.id, fork);
    await chat.input(forked.id, text).catch(() => saveDraft(forked.id, text));
    return forked.id;
  };
}

/** The words a fork starts with, in a sheet: shown while there is `text`. */
function ForkEditor({
  title,
  caption,
  placeholder,
  text,
  setText,
  send,
  close,
}: {
  title: string;
  caption: string;
  placeholder?: string;
  text: string | undefined;
  setText: (text: string) => void;
  send: (text: string) => Promise<void>;
  close: () => void;
}) {
  const faint = String(useCSSVariable("--color-faint"));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const cancel = () => {
    setError("");
    close();
  };
  return (
    <Modal
      visible={text !== undefined}
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={cancel}
    >
      <View className="flex-1 bg-background">
        <View className="flex-row items-center justify-between border-b border-border px-5 py-3">
          <Pressable accessibilityRole="button" onPress={cancel} hitSlop={12}>
            <Text className="text-base text-muted-foreground">Cancel</Text>
          </Pressable>
          <Text className="text-[17px] font-semibold">{title}</Text>
          <Pressable
            accessibilityRole="button"
            disabled={busy || !text?.trim()}
            onPress={() => {
              setBusy(true);
              setError("");
              send(text!.trim())
                .catch((e: unknown) => setError(errorMessage(e)))
                .finally(() => setBusy(false));
            }}
            hitSlop={12}
            className="disabled:opacity-40"
          >
            <Text className="text-base font-medium text-human-foreground">
              Send
            </Text>
          </Pressable>
        </View>
        <View className="gap-3 px-5 py-4">
          <Text className="text-sm text-muted-foreground">{caption}</Text>
          <TextInput
            value={text ?? ""}
            onChangeText={setText}
            multiline
            autoFocus
            editable={!busy}
            placeholder={placeholder}
            placeholderTextColor={faint}
            className="min-h-32 rounded-md border border-input bg-card px-3 py-2.5 text-[15px] leading-[21px] text-foreground"
            textAlignVertical="top"
          />
          {error ? (
            <Text className="text-sm text-destructive">{error}</Text>
          ) : null}
        </View>
      </View>
    </Modal>
  );
}

/**
 * In About, for the session's person: a fork that goes on from all of its work, and a side
 * chat, a fork asked a question there, so this one is not touched.
 */
export function ForkSession({
  session,
  close,
}: {
  session: ChatSession;
  close: () => void;
}) {
  const { chat } = useSession();
  const { mine, here } = useAccess(session);
  const router = useRouter();
  const forkWith = useForkWith();
  const [asking, setAsking] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  if (!mine || !here) return null;
  const open = (id: string) => {
    close();
    router.push(`/session/${id}`);
  };
  return (
    <View className="gap-2">
      <View className="flex-row gap-2">
        <Button
          variant="outline"
          className="flex-1"
          disabled={busy}
          onPress={() => {
            setBusy(true);
            setError("");
            chat
              .forkSession(session.id)
              .then(({ session: fork }) => open(fork.id))
              .catch((e: unknown) => setError(errorMessage(e)))
              .finally(() => setBusy(false));
          }}
        >
          <Text>Fork</Text>
        </Button>
        <Button
          variant="outline"
          className="flex-1"
          disabled={busy}
          onPress={() => setAsking("")}
        >
          <Text>Side chat</Text>
        </Button>
      </View>
      <Text
        className={error ? "text-xs text-destructive" : "text-xs text-faint"}
      >
        {error ||
          "Both go on from all of this session's work in a new one, a side chat with your question. This one stays as it is."}
      </Text>
      <ForkEditor
        title="Side chat"
        caption="Your question goes to a new session with all of this one's work. This one stays as it is."
        placeholder="Ask about this session"
        text={asking}
        setText={setAsking}
        send={async (text) => {
          const id = await forkWith(session, {}, text);
          setAsking(undefined);
          open(id);
        }}
        close={() => setAsking(undefined)}
      />
    </View>
  );
}
