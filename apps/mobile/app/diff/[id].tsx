import * as Haptics from "expo-haptics";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useState } from "react";
import { Pressable, TextInput, View } from "react-native";
import { KeyboardStickyView } from "react-native-keyboard-controller";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useCSSVariable } from "uniwind";
import {
  errorMessage,
  lineComment,
  useSessionDiff,
  useSessionGit,
} from "@zerolux/chat";
import type { GitDiffLine } from "@zerolux/chat";
import { Screen } from "@/components/screen";
import { Button } from "@/components/ui/button";
import { ChatList } from "@/components/ui/native";
import { Text } from "@/components/ui/text";
import { cn } from "@/lib/utils";
import { useSession } from "../../src/kernel";

/** A line's number in the file as it is now; a removed line has only the one it had. */
const lineNumber = (line: GitDiffLine) => line.new ?? line.old;

/**
 * One file's changes in a session's folder, staged or not, line by line as git shows them.
 * Tapping a line, then another, picks the lines between to comment on: the note goes to the
 * session as the owner's input, naming the file and the lines.
 */
export default function DiffPage() {
  const { id, path, staged } = useLocalSearchParams<{
    id: string;
    path: string;
    staged: string;
  }>();
  const inIndex = staged === "true";
  const { chat, url } = useSession();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const faint = String(useCSSVariable("--color-faint"));
  const session = chat.sessions.find((s) => s.id === id);
  const { diff, error: readError } = useSessionDiff(
    id,
    path,
    inIndex,
    session?.output_at,
    url,
  );
  const git = useSessionGit(id, session?.output_at, url);
  // The lines picked, by their place in the diff: from the first tapped to the last.
  const [picked, setPicked] = useState<{ from: number; to: number }>();
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const lines = diff?.lines ?? [];
  const pick = (index: number) => {
    void Haptics.selectionAsync();
    setPicked((was) =>
      !was || was.from !== was.to
        ? { from: index, to: index }
        : was.from === index
          ? undefined
          : {
              from: Math.min(was.from, index),
              to: Math.max(was.from, index),
            },
    );
  };
  const span = picked && {
    from: lineNumber(lines[picked.from]!) ?? 0,
    to: lineNumber(lines[picked.to]!) ?? 0,
  };
  const send = async () => {
    if (!span) return;
    setBusy(true);
    setError("");
    try {
      await chat.input(id, lineComment(path, span.from, span.to, note));
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      setPicked(undefined);
      setNote("");
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  const move = async () => {
    setBusy(true);
    setError("");
    try {
      await (inIndex ? git.unstage([path]) : git.stage([path]));
      router.back();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Screen
      back
      title={path.split("/").at(-1) ?? path}
      subtitle={
        diff
          ? `${inIndex ? "Staged" : "Not staged"} · +${diff.added} -${diff.removed}`
          : path
      }
      action={
        <Button
          size="sm"
          variant="ghost"
          disabled={busy}
          onPress={() => void move()}
        >
          <Text>{inIndex ? "Unstage" : "Stage"}</Text>
        </Button>
      }
    >
      <ChatList
        data={lines}
        keyExtractor={(_, index) => String(index)}
        renderItem={({ item, index }) => (
          <DiffRow
            line={item as GitDiffLine}
            picked={
              picked !== undefined && index >= picked.from && index <= picked.to
            }
            pick={() => pick(index)}
          />
        )}
        contentContainerClassName="py-2"
        keyboardDismissMode="interactive"
        keyboardOffset={insets.bottom}
        ListEmptyComponent={
          <Text
            className={cn(
              "px-4 py-2 text-sm",
              readError ? "text-destructive" : "text-faint",
            )}
          >
            {readError ||
              (diff?.binary
                ? "A binary file: git shows no lines."
                : diff
                  ? "No changes here now."
                  : "Reading the diff…")}
          </Text>
        }
      />
      {span ? (
        <KeyboardStickyView offset={{ closed: 0, opened: insets.bottom }}>
          <View
            className="gap-1.5 border-t border-border bg-background px-3 pt-2"
            style={{ paddingBottom: 8 + insets.bottom }}
          >
            <View className="flex-row items-center justify-between">
              <Text className="font-mono text-xs text-muted-foreground">
                {span.from === span.to
                  ? `Line ${span.from}`
                  : `Lines ${span.from}-${span.to}`}
              </Text>
              <Pressable
                accessibilityRole="button"
                onPress={() => setPicked(undefined)}
                hitSlop={8}
              >
                <Text className="text-[13px] text-muted-foreground">
                  Cancel
                </Text>
              </Pressable>
            </View>
            {error ? (
              <Text className="text-sm text-destructive">{error}</Text>
            ) : null}
            <View className="flex-row items-end gap-2">
              <TextInput
                value={note}
                onChangeText={setNote}
                multiline
                autoFocus
                editable={!busy}
                placeholder="Comment for the agent"
                placeholderTextColor={faint}
                accessibilityLabel="Comment on the lines"
                className="max-h-28 flex-1 rounded-md border border-input bg-card px-3 py-2 font-sans text-[15px] text-foreground"
              />
              <Button
                disabled={busy || !note.trim()}
                onPress={() => void send()}
              >
                <Text>Send</Text>
              </Button>
            </View>
          </View>
        </KeyboardStickyView>
      ) : null}
    </Screen>
  );
}

/** One line of the diff: a hunk's header, or a line with its number, kept, added or removed. */
function DiffRow({
  line,
  picked,
  pick,
}: {
  line: GitDiffLine;
  picked: boolean;
  pick: () => void;
}) {
  if (line.kind === "hunk")
    return (
      <Text
        numberOfLines={1}
        className="mt-1 bg-muted px-3 py-1 font-mono text-[11px] text-muted-foreground"
      >
        {line.text}
      </Text>
    );
  return (
    <Pressable
      onPress={pick}
      accessibilityRole="button"
      accessibilityState={{ selected: picked }}
      className={cn(
        "flex-row",
        line.kind === "added" && "bg-success/10",
        line.kind === "removed" && "bg-destructive/10",
        picked && "bg-human/25",
      )}
    >
      <Text
        className={cn(
          "w-10 pr-1.5 text-right font-mono text-[11px] leading-[18px] text-faint",
          line.kind === "removed" && "opacity-60",
        )}
      >
        {lineNumber(line) ?? ""}
      </Text>
      <Text
        className={cn(
          "w-4 text-center font-mono text-xs leading-[18px]",
          line.kind === "added" && "text-success",
          line.kind === "removed" && "text-destructive",
        )}
      >
        {line.kind === "added" ? "+" : line.kind === "removed" ? "-" : ""}
      </Text>
      <Text
        className={cn(
          "flex-1 pr-2 font-mono text-xs leading-[18px]",
          line.kind === "same" ? "text-faint" : "text-foreground/90",
        )}
      >
        {line.text || " "}
      </Text>
    </Pressable>
  );
}
