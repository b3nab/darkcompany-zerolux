import { useRouter } from "expo-router";
import { ChevronRightIcon } from "lucide-react-native";
import { useEffect, useState } from "react";
import { Pressable, View } from "react-native";
import { useCSSVariable } from "uniwind";
import { taskState } from "@zerolux/chat";
import type { ChatSession, Task } from "@zerolux/chat";
import { Text } from "@/components/ui/text";
import { cn } from "@/lib/utils";

/** The time now, read again every second while `ticking`. */
export function useNow(ticking: boolean) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!ticking) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [ticking]);
  return now;
}

/**
 * The commands a session runs in the background, newest first, each with how it stands; a
 * tap opens its output.
 */
export function TaskList({
  session,
  tasks,
  error,
}: {
  session: ChatSession;
  tasks: Task[] | undefined;
  error: string;
}) {
  const router = useRouter();
  const faint = String(useCSSVariable("--color-faint"));
  const now = useNow(Boolean(tasks?.some((t) => t.status === "running")));
  return (
    <View className="gap-2">
      {error ? <Text className="text-xs text-destructive">{error}</Text> : null}
      {tasks?.length ? (
        <View className="overflow-hidden rounded-md border border-border">
          {tasks.map((task, index) => (
            <Pressable
              key={task.id}
              accessibilityRole="button"
              onPress={() =>
                router.push({
                  pathname: "/task/[id]",
                  params: { id: task.id, session: session.id },
                })
              }
              className={cn(
                "flex-row items-center gap-3 bg-card px-3 py-2.5 active:bg-accent",
                index > 0 && "border-t border-border",
              )}
            >
              <View
                className={cn(
                  "size-2 rounded-full",
                  task.status === "running"
                    ? "bg-success"
                    : task.status === "exited" && task.exit_code === 0
                      ? "bg-faint"
                      : "bg-destructive",
                )}
              />
              <View className="min-w-0 flex-1 gap-0.5">
                <Text numberOfLines={1} className="font-mono text-[13px]">
                  {task.command}
                </Text>
                <Text className="text-xs text-faint">
                  {taskState(task, now)}
                </Text>
              </View>
              <ChevronRightIcon color={faint} size={16} strokeWidth={1.5} />
            </Pressable>
          ))}
        </View>
      ) : tasks ? (
        <Text className="text-sm text-faint">No tasks.</Text>
      ) : null}
    </View>
  );
}
