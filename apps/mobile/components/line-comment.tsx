import * as Haptics from "expo-haptics";
import { useState } from "react";
import { Pressable, TextInput, View } from "react-native";
import { KeyboardStickyView } from "react-native-keyboard-controller";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useCSSVariable } from "uniwind";
import { errorMessage, lineComment } from "@zerolux/chat";
import { Button } from "@/components/ui/button";
import { Text } from "@/components/ui/text";
import { useSession } from "../src/kernel";

/**
 * Lines picked to comment on, by their place in a list: a tap picks one, a tap on another
 * the lines between, a tap on the one picked lets it go.
 */
export function useLinePick() {
  const [picked, setPicked] = useState<{ from: number; to: number }>();
  return {
    picked,
    pick(index: number) {
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
    },
    has: (index: number) =>
      picked !== undefined && index >= picked.from && index <= picked.to,
    clear: () => setPicked(undefined),
  };
}

/**
 * The box for a note on lines of a file, above the keyboard: it goes to the session as the
 * owner's input, naming the file and the lines.
 */
export function LineComment({
  sessionId,
  path,
  from,
  to,
  done,
}: {
  sessionId: string;
  path: string;
  from: number;
  to: number;
  done: () => void;
}) {
  const { chat } = useSession();
  const insets = useSafeAreaInsets();
  const faint = String(useCSSVariable("--color-faint"));
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const send = async () => {
    setBusy(true);
    setError("");
    try {
      await chat.input(sessionId, lineComment(path, from, to, note));
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      setNote("");
      done();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <KeyboardStickyView offset={{ closed: 0, opened: insets.bottom }}>
      <View
        className="gap-1.5 border-t border-border bg-background px-3 pt-2"
        style={{ paddingBottom: 8 + insets.bottom }}
      >
        <View className="flex-row items-center justify-between">
          <Text className="font-mono text-xs text-muted-foreground">
            {from === to ? `Line ${from}` : `Lines ${from}-${to}`}
          </Text>
          <Pressable accessibilityRole="button" onPress={done} hitSlop={8}>
            <Text className="text-[13px] text-muted-foreground">Cancel</Text>
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
          <Button disabled={busy || !note.trim()} onPress={() => void send()}>
            <Text>Send</Text>
          </Button>
        </View>
      </View>
    </KeyboardStickyView>
  );
}
