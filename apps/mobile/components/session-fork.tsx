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
import type { ChatSession, FilesRewind, SessionBlock } from "@zerolux/chat";
import { Button } from "@/components/ui/button";
import { Text } from "@/components/ui/text";
import { useSession } from "../src/kernel";
import { useMe } from "../src/me";

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
  const router = useRouter();
  const [editing, setEditing] = useState<{ block: InputBlock; text: string }>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
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
      {
        label: "Edit and resend",
        run: () => {
          setError("");
          setEditing({ block, text: block.text });
        },
      },
      // Only Claude Code keeps checkpoints; the others' files come back through their changes.
      ...(session.harness === "claude-code"
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
  const resend = async () => {
    if (!editing || !session) return;
    const text = editing.text.trim();
    setBusy(true);
    setError("");
    try {
      const { session: fork } = await chat.forkSession(session.id, {
        at: editing.block.at,
      });
      // The fork is there either way: words it did not take wait in its box.
      await chat.input(fork.id, text).catch(() => saveDraft(fork.id, text));
      setEditing(undefined);
      router.push(`/session/${fork.id}`);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  const sheet = (
    <Modal
      visible={Boolean(editing)}
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={() => setEditing(undefined)}
    >
      <View className="flex-1 bg-background">
        <View className="flex-row items-center justify-between border-b border-border px-5 py-3">
          <Pressable
            accessibilityRole="button"
            onPress={() => setEditing(undefined)}
            hitSlop={12}
          >
            <Text className="text-base text-muted-foreground">Cancel</Text>
          </Pressable>
          <Text className="text-[17px] font-semibold">Edit and resend</Text>
          <Pressable
            accessibilityRole="button"
            disabled={busy || !editing?.text.trim()}
            onPress={() => void resend()}
            hitSlop={12}
            className="disabled:opacity-40"
          >
            <Text className="text-base font-medium text-human-foreground">
              Send
            </Text>
          </Pressable>
        </View>
        <View className="gap-3 px-5 py-4">
          <Text className="text-sm text-muted-foreground">
            A new session goes on from before this message, with your new words.
            This one stays as it is.
          </Text>
          <TextInput
            value={editing?.text ?? ""}
            onChangeText={(text) =>
              setEditing((current) => current && { ...current, text })
            }
            multiline
            autoFocus
            editable={!busy}
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
  return { open, sheet };
}

/** In About: a new session that goes on from all of this one, which stays as it is. */
export function ForkSession({
  session,
  close,
}: {
  session: ChatSession;
  close: () => void;
}) {
  const { chat } = useSession();
  const { owner } = useMe();
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  if (!owner) return null;
  return (
    <View className="gap-2">
      <Button
        variant="outline"
        disabled={busy}
        onPress={() => {
          setBusy(true);
          setError("");
          chat
            .forkSession(session.id)
            .then(({ session: fork }) => {
              close();
              router.push(`/session/${fork.id}`);
            })
            .catch((e: unknown) => setError(errorMessage(e)))
            .finally(() => setBusy(false));
        }}
      >
        <Text>Fork</Text>
      </Button>
      <Text
        className={error ? "text-xs text-destructive" : "text-xs text-faint"}
      >
        {error ||
          "A new session goes on from all of this one's work. This one stays as it is."}
      </Text>
    </View>
  );
}
