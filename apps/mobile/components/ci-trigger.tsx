import { useState } from "react";
import { Alert, Pressable, Switch, TextInput, View } from "react-native";
import { useCSSVariable } from "uniwind";
import {
  clockTime,
  dayLabel,
  errorMessage,
  useSessionTriggers,
} from "@zerolux/chat";
import type { ChatSession, TriggerChange } from "@zerolux/chat";
import { Button } from "@/components/ui/button";
import { Text } from "@/components/ui/text";
import { cn } from "@/lib/utils";
import { useSession } from "../src/kernel";
import { useAccess } from "../src/me";

/**
 * In About, for whoever works in the session: it hears the CI of its folder's current commit
 * once all its runs end, only the failures or every result, with words of yours after them.
 */
export function CiTrigger({ session }: { session: ChatSession }) {
  const { url } = useSession();
  const { write } = useAccess(session);
  const faint = String(useCSSVariable("--color-faint"));
  const triggers = useSessionTriggers(
    write ? session.id : undefined,
    session.output_at,
    url,
  );
  const trigger = triggers.triggers?.find((t) => t.event === "ci");
  // The prompt as typed, until it is saved.
  const [prompt, setPrompt] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  if (!write) return null;
  const act = async (work: () => Promise<unknown>) => {
    setBusy(true);
    setError("");
    try {
      await work();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  const change = (next: TriggerChange) =>
    trigger && void act(() => triggers.change(trigger.id, next));
  return (
    <View className="gap-2">
      <Text className="text-sm text-faint">When CI ends</Text>
      {trigger ? (
        <View className="gap-3 rounded-md border border-border bg-card px-3.5 py-3">
          <View className="flex-row items-center justify-between gap-3">
            <Text className="flex-1 text-[15px]">Tell it the results</Text>
            <Switch
              accessibilityLabel="Tell it the results"
              value={trigger.enabled}
              disabled={busy}
              onValueChange={(enabled) => change({ enabled })}
            />
          </View>
          <View className="flex-row items-center justify-between gap-3">
            <Text className="flex-1 text-[15px]">Only failures</Text>
            <Switch
              accessibilityLabel="Only failures"
              value={trigger.failures_only}
              disabled={busy}
              onValueChange={(failures_only) => change({ failures_only })}
            />
          </View>
          <TextInput
            value={prompt ?? trigger.prompt}
            onChangeText={setPrompt}
            onEndEditing={() => {
              if (prompt !== undefined && prompt !== trigger.prompt)
                change({ prompt: prompt.trim() });
              setPrompt(undefined);
            }}
            multiline
            editable={!busy}
            placeholder="Fix what failed"
            placeholderTextColor={faint}
            accessibilityLabel="What it hears after the results"
            className="min-h-16 rounded-md border border-input bg-background px-3 py-2 font-sans text-[15px] text-foreground"
            textAlignVertical="top"
          />
          <View className="flex-row items-center justify-between gap-3">
            <Text
              className={cn(
                "flex-1 text-xs",
                trigger.last_error ? "text-attention" : "text-faint",
              )}
            >
              {trigger.last_error
                ? `Last check: ${trigger.last_error}`
                : trigger.last_run_at
                  ? `Last heard ${dayLabel(trigger.last_run_at)} at ${clockTime(trigger.last_run_at)}`
                  : "Not heard yet."}
            </Text>
            <Pressable
              accessibilityRole="button"
              disabled={busy}
              hitSlop={8}
              onPress={() =>
                Alert.alert("Stop waiting for CI?", undefined, [
                  { text: "Cancel", style: "cancel" },
                  {
                    text: "Remove",
                    style: "destructive",
                    onPress: () => void act(() => triggers.remove(trigger.id)),
                  },
                ])
              }
            >
              <Text className="text-[13px] font-medium text-destructive">
                Remove
              </Text>
            </Pressable>
          </View>
        </View>
      ) : triggers.triggers ? (
        <Button
          variant="outline"
          disabled={busy}
          onPress={() => void act(() => triggers.create())}
        >
          <Text>Tell it when CI ends</Text>
        </Button>
      ) : null}
      <Text
        className={cn(
          "text-xs",
          error || triggers.error ? "text-destructive" : "text-faint",
        )}
      >
        {error ||
          triggers.error ||
          "Each minute ZeroLux asks GitHub about the CI of its folder's current commit; when all runs end, the session hears the results after its turn."}
      </Text>
    </View>
  );
}
