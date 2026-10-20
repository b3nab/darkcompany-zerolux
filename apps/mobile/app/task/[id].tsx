import { useLocalSearchParams } from "expo-router";
import { useRef, useState } from "react";
import { Alert, ScrollView, View } from "react-native";
import type { ScrollViewInstance } from "react-native";
import {
  errorMessage,
  plainOutput,
  taskState,
  useSessionTasks,
  useTaskOutput,
} from "@zerolux/chat";
import { Screen } from "@/components/screen";
import { useNow } from "@/components/tasks";
import { Button } from "@/components/ui/button";
import { Text } from "@/components/ui/text";
import { useSession } from "../../src/kernel";
import { useAccess } from "../../src/me";

/** How much of the output the phone draws: its end. */
const DRAWN = 60_000;

/**
 * A session's task: its command and how it stands, its output as it grows, following its end
 * unless scrolled up; and Stop, for whoever works in the session.
 */
export default function TaskPage() {
  const { id, session: sessionId } = useLocalSearchParams<{
    id: string;
    session: string;
  }>();
  const { url, chat } = useSession();
  const { write } = useAccess(chat.sessions.find((s) => s.id === sessionId));
  const tasks = useSessionTasks(sessionId, url);
  const task = tasks.tasks?.find((t) => t.id === id);
  const running = task?.status === "running";
  const output = useTaskOutput(task ? id : undefined, running, url);
  const now = useNow(running);
  const scroll = useRef<ScrollViewInstance>(null);
  // At the end, the view follows the output; scrolled up, it stays.
  const following = useRef(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const text = plainOutput(output.text).slice(-DRAWN);
  const stop = () =>
    Alert.alert("Stop this task?", undefined, [
      { text: "Cancel", style: "cancel" },
      {
        text: "Stop",
        style: "destructive",
        onPress: () => {
          setBusy(true);
          setError("");
          tasks
            .stop(id)
            .catch((e: unknown) => setError(errorMessage(e)))
            .finally(() => setBusy(false));
        },
      },
    ]);
  return (
    <Screen
      back
      title="Task"
      subtitle={task ? taskState(task, now) : undefined}
    >
      {task ? (
        <View className="flex-1 gap-3 px-5 pb-5 pt-2">
          <Text selectable className="font-mono text-[13px]">
            {task.command}
          </Text>
          {task.error || output.error || error ? (
            <Text className="text-sm text-destructive">
              {error || output.error || task.error}
            </Text>
          ) : null}
          <ScrollView
            ref={scroll}
            className="flex-1 rounded-md border border-border bg-card"
            contentContainerClassName="px-3 py-2.5"
            onScroll={(e) => {
              const { contentOffset, contentSize, layoutMeasurement } =
                e.nativeEvent;
              following.current =
                contentSize.height -
                  layoutMeasurement.height -
                  contentOffset.y <
                24;
            }}
            scrollEventThrottle={100}
            onContentSizeChange={() =>
              following.current &&
              scroll.current?.scrollToEnd({ animated: false })
            }
          >
            <Text selectable className="font-mono text-[12px] leading-[17px]">
              {text || (running ? "No output yet." : "No output.")}
            </Text>
          </ScrollView>
          {running && write ? (
            <Button variant="destructive" disabled={busy} onPress={stop}>
              <Text>{busy ? "Stopping…" : "Stop"}</Text>
            </Button>
          ) : null}
        </View>
      ) : (
        <Text className="px-5 pt-2 text-sm text-faint">
          {tasks.error || (tasks.tasks ? "This task is gone." : "Reading it…")}
        </Text>
      )}
    </Screen>
  );
}
