import { useLocalSearchParams, useRouter } from "expo-router";
import { useState } from "react";
import { Pressable } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { errorMessage, useSessionDiff, useSessionGit } from "@zerolux/chat";
import type { GitDiffLine } from "@zerolux/chat";
import { LineComment, useLinePick } from "@/components/line-comment";
import { Screen } from "@/components/screen";
import { Button } from "@/components/ui/button";
import { ChatList } from "@/components/ui/native";
import { Text } from "@/components/ui/text";
import { cn } from "@/lib/utils";
import { useSession } from "../../src/kernel";
import { useAccess } from "../../src/me";

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
  const session = chat.sessions.find((s) => s.id === id);
  // Following a shared session shows the diff; working in it stages and comments.
  const { write } = useAccess(session);
  const { diff, error: readError } = useSessionDiff(
    id,
    path,
    inIndex,
    session?.output_at,
    url,
  );
  const git = useSessionGit(id, session?.output_at, url);
  const lines = diff?.lines ?? [];
  const pick = useLinePick();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
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
        write ? (
          <Button
            size="sm"
            variant="ghost"
            disabled={busy}
            onPress={() => void move()}
          >
            <Text>{inIndex ? "Unstage" : "Stage"}</Text>
          </Button>
        ) : undefined
      }
    >
      <ChatList
        data={lines}
        keyExtractor={(_, index) => String(index)}
        renderItem={({ item, index }) => (
          <DiffRow
            line={item as GitDiffLine}
            picked={pick.has(index)}
            pick={write ? () => pick.pick(index) : undefined}
          />
        )}
        contentContainerClassName="py-2"
        keyboardDismissMode="interactive"
        keyboardOffset={insets.bottom}
        ListHeaderComponent={
          error ? (
            <Text className="px-4 pb-2 text-sm text-destructive">{error}</Text>
          ) : null
        }
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
      {pick.picked ? (
        <LineComment
          sessionId={id}
          path={path}
          from={lineNumber(lines[pick.picked.from]!) ?? 0}
          to={lineNumber(lines[pick.picked.to]!) ?? 0}
          done={pick.clear}
        />
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
  /** Picks the line to comment on; none for who only follows the session. */
  pick?: () => void;
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
      disabled={!pick}
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
