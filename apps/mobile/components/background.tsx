import { useRouter } from "expo-router";
import { ChevronRightIcon } from "lucide-react-native";
import { useEffect, useState } from "react";
import { Pressable, View } from "react-native";
import { useCSSVariable } from "uniwind";
import { backgroundState } from "@zerolux/chat";
import type { BackgroundCommand, ChatSession } from "@zerolux/chat";
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
export function BackgroundList({
  session,
  commands,
  error,
}: {
  session: ChatSession;
  commands: BackgroundCommand[] | undefined;
  error: string;
}) {
  const router = useRouter();
  const faint = String(useCSSVariable("--color-faint"));
  const now = useNow(Boolean(commands?.some((c) => c.status === "running")));
  return (
    <View className="gap-2">
      {error ? <Text className="text-xs text-destructive">{error}</Text> : null}
      {commands?.length ? (
        <View className="overflow-hidden rounded-md border border-border">
          {commands.map((command, index) => (
            <Pressable
              key={command.id}
              accessibilityRole="button"
              onPress={() =>
                router.push({
                  pathname: "/background-command/[id]",
                  params: { id: command.id, session: session.id },
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
                  command.status === "running"
                    ? "bg-success"
                    : command.status === "exited" && command.exit_code === 0
                      ? "bg-faint"
                      : "bg-destructive",
                )}
              />
              <View className="min-w-0 flex-1 gap-0.5">
                <Text numberOfLines={1} className="font-mono text-[13px]">
                  {command.command}
                </Text>
                <Text className="text-xs text-faint">
                  {backgroundState(command, now)}
                </Text>
              </View>
              <ChevronRightIcon color={faint} size={16} strokeWidth={1.5} />
            </Pressable>
          ))}
        </View>
      ) : commands ? (
        <Text className="text-sm text-faint">No background commands.</Text>
      ) : null}
    </View>
  );
}
