import * as Clipboard from "expo-clipboard";
import * as Haptics from "expo-haptics";
import { useLocalSearchParams } from "expo-router";
import { useEffect, useMemo, useState } from "react";
import { Pressable } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { errorMessage, sessionFile } from "@zerolux/chat";
import { LineComment, useLinePick } from "@/components/line-comment";
import { Screen } from "@/components/screen";
import { Button } from "@/components/ui/button";
import { ChatList } from "@/components/ui/native";
import { Text } from "@/components/ui/text";
import { cn } from "@/lib/utils";
import { useSession } from "../../src/kernel";
import { useAccess } from "../../src/me";

/**
 * A file of a session's folder as it is now, line by line with its numbers, read again as the
 * agent writes. Tapping a line, then another, picks the lines between to comment on: the note
 * goes to the session as the owner's input, naming the file and the lines.
 */
export default function FilePage() {
  const { id, path } = useLocalSearchParams<{ id: string; path: string }>();
  const { chat, url } = useSession();
  const insets = useSafeAreaInsets();
  const session = chat.sessions.find((s) => s.id === id);
  // Following a shared session shows its files; working in it comments on them.
  const { write } = useAccess(session);
  const [read, setRead] = useState<{ text?: string; error?: string }>({});
  useEffect(() => {
    let current = true;
    sessionFile(id, path, url).then(
      (text) => current && setRead({ text }),
      (e: unknown) => current && setRead({ error: errorMessage(e) }),
    );
    return () => {
      current = false;
    };
  }, [id, path, url, session?.output_at]);
  // A last newline ends the last line; it starts none.
  const lines = useMemo(
    () => read.text?.replace(/\n$/, "").split("\n") ?? [],
    [read.text],
  );
  const pick = useLinePick();
  const folder = path.split("/").slice(0, -1).join("/");
  return (
    <Screen
      back
      title={path.split("/").at(-1) ?? path}
      subtitle={
        read.text !== undefined
          ? `${folder ? `${folder} · ` : ""}${lines.length} ${lines.length === 1 ? "line" : "lines"}`
          : folder || undefined
      }
      action={
        <Button
          size="sm"
          variant="ghost"
          disabled={read.text === undefined}
          onPress={() => {
            void Clipboard.setStringAsync(read.text ?? "");
            void Haptics.selectionAsync();
          }}
        >
          <Text>Copy</Text>
        </Button>
      }
    >
      <ChatList
        data={lines}
        keyExtractor={(_, index) => String(index)}
        renderItem={({ item, index }) => (
          <Pressable
            disabled={!write}
            onPress={() => pick.pick(index)}
            accessibilityRole="button"
            accessibilityState={{ selected: pick.has(index) }}
            className={cn("flex-row", pick.has(index) && "bg-human/25")}
          >
            <Text className="w-11 pr-2 text-right font-mono text-[11px] leading-[18px] text-faint">
              {index + 1}
            </Text>
            <Text className="flex-1 pr-2 font-mono text-xs leading-[18px] text-foreground/90">
              {(item as string) || " "}
            </Text>
          </Pressable>
        )}
        contentContainerClassName="py-2"
        keyboardDismissMode="interactive"
        keyboardOffset={insets.bottom}
        ListEmptyComponent={
          <Text
            className={cn(
              "px-4 py-2 text-sm",
              read.error ? "text-destructive" : "text-faint",
            )}
          >
            {read.error || "Reading the file…"}
          </Text>
        }
      />
      {pick.picked ? (
        <LineComment
          sessionId={id}
          path={path}
          from={pick.picked.from + 1}
          to={pick.picked.to + 1}
          done={pick.clear}
        />
      ) : null}
    </Screen>
  );
}
