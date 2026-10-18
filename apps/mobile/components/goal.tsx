import { useState } from "react";
import {
  Alert,
  Modal,
  Pressable,
  ScrollView,
  TextInput,
  View,
} from "react-native";
import { useCSSVariable } from "uniwind";
import {
  clearSessionGoal,
  errorMessage,
  goalStatusLabels,
  setSessionGoal,
  tokenCount,
  useSessionGoal,
} from "@zerolux/chat";
import type { ChatSession, GoalChange, SessionGoal } from "@zerolux/chat";
import { Button } from "@/components/ui/button";
import { Text } from "@/components/ui/text";
import { useSession } from "../src/kernel";
import { useAccess } from "../src/me";

/** How long it has worked toward it, in hours and minutes. */
function spent(seconds: number) {
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  return `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
}

/**
 * In About, for a Codex session: the goal it works toward on its own, turn after turn, with
 * what it has spent; who works in the session sets it, pauses, resumes, closes or clears it.
 */
export function GoalSection({ session }: { session: ChatSession }) {
  const { chat, url } = useSession();
  const { read, write } = useAccess(session);
  const goal = useSessionGoal(session.id, chat.live);
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  if (session.harness !== "codex" || !read) return null;
  const act = async (work: () => Promise<unknown>) => {
    setBusy(true);
    setError("");
    try {
      await work();
      return true;
    } catch (e) {
      setError(errorMessage(e));
      return false;
    } finally {
      setBusy(false);
    }
  };
  const change = (next: GoalChange) =>
    void act(() => setSessionGoal(session.id, next, url));
  return (
    <View className="gap-2">
      <Text className="text-sm text-faint">Goal</Text>
      {goal ? (
        <View className="gap-2.5 rounded-md border border-border bg-card px-3.5 py-3">
          <Text className="text-[15px] leading-[21px]">{goal.objective}</Text>
          <Text className="text-xs text-faint">
            {goalStatusLabels[goal.status]} · {tokenCount(goal.tokens_used)}
            {goal.token_budget !== null
              ? ` of ${tokenCount(goal.token_budget)}`
              : ""}{" "}
            tokens · {spent(goal.time_used_seconds)}
          </Text>
          {write ? (
            <View className="flex-row flex-wrap gap-2">
              {goal.status === "active" ? (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy}
                  onPress={() => change({ status: "paused" })}
                >
                  <Text>Pause</Text>
                </Button>
              ) : goal.status !== "complete" ? (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy}
                  onPress={() => change({ status: "active" })}
                >
                  <Text>Resume</Text>
                </Button>
              ) : null}
              {goal.status !== "complete" ? (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy}
                  onPress={() => change({ status: "complete" })}
                >
                  <Text>Done</Text>
                </Button>
              ) : null}
              <Button
                size="sm"
                variant="outline"
                disabled={busy}
                onPress={() => setEditing(true)}
              >
                <Text>Edit</Text>
              </Button>
              <Button
                size="sm"
                variant="ghost"
                disabled={busy}
                onPress={() =>
                  Alert.alert("Clear the goal?", undefined, [
                    { text: "Cancel", style: "cancel" },
                    {
                      text: "Clear",
                      style: "destructive",
                      onPress: () =>
                        void act(() => clearSessionGoal(session.id, url)),
                    },
                  ])
                }
              >
                <Text className="text-destructive">Clear</Text>
              </Button>
            </View>
          ) : null}
        </View>
      ) : write ? (
        <Button
          variant="outline"
          disabled={busy}
          onPress={() => setEditing(true)}
        >
          <Text>Set a goal</Text>
        </Button>
      ) : (
        <Text className="text-xs text-faint">No goal.</Text>
      )}
      <Text
        className={error ? "text-xs text-destructive" : "text-xs text-faint"}
      >
        {error ||
          "Codex works toward it on its own, turn after turn, until it is done or reaches its budget."}
      </Text>
      <Modal
        visible={editing}
        animationType="slide"
        presentationStyle="pageSheet"
        onRequestClose={() => setEditing(false)}
      >
        <GoalForm
          goal={goal}
          save={async (objective, budget) => {
            const saved = await act(() =>
              setSessionGoal(
                session.id,
                goal
                  ? { objective, token_budget: budget }
                  : {
                      objective,
                      status: "active",
                      ...(budget === null ? {} : { token_budget: budget }),
                    },
                url,
              ),
            );
            if (saved) setEditing(false);
          }}
          busy={busy}
          error={error}
          close={() => setEditing(false)}
        />
      </Modal>
    </View>
  );
}

/** A goal's objective and, if any, the tokens it may spend. */
function GoalForm({
  goal,
  save,
  busy,
  error,
  close,
}: {
  goal: SessionGoal | null;
  save: (objective: string, budget: number | null) => Promise<void>;
  busy: boolean;
  error: string;
  close: () => void;
}) {
  const faint = String(useCSSVariable("--color-faint"));
  const [objective, setObjective] = useState(goal?.objective ?? "");
  const [budget, setBudget] = useState(
    goal?.token_budget != null ? String(goal.token_budget) : "",
  );
  const tokens = budget.trim() ? Number(budget.replace(/[^\d]/g, "")) : null;
  const ready = objective.trim() && (tokens === null || tokens > 0);
  return (
    <View className="flex-1 bg-background">
      <View className="flex-row items-center justify-between border-b border-border px-5 py-3">
        <Pressable accessibilityRole="button" onPress={close} hitSlop={12}>
          <Text className="text-base text-muted-foreground">Cancel</Text>
        </Pressable>
        <Text className="text-[17px] font-semibold">Goal</Text>
        <Pressable
          accessibilityRole="button"
          disabled={busy || !ready}
          onPress={() => void save(objective.trim(), tokens)}
          hitSlop={12}
          className="disabled:opacity-40"
        >
          <Text className="text-base font-medium text-human-foreground">
            Save
          </Text>
        </Pressable>
      </View>
      <ScrollView contentContainerClassName="gap-5 px-5 py-5">
        <View className="gap-2">
          <Text className="text-sm font-medium">What it works toward</Text>
          <TextInput
            value={objective}
            onChangeText={setObjective}
            multiline
            autoFocus
            placeholder="All tests pass on the new parser"
            placeholderTextColor={faint}
            textAlignVertical="top"
            className="min-h-28 rounded-md border border-input bg-card px-3 py-2.5 font-sans text-[15px] leading-[21px] text-foreground"
          />
        </View>
        <View className="gap-2">
          <Text className="text-sm font-medium">Token budget</Text>
          <TextInput
            value={budget}
            onChangeText={setBudget}
            keyboardType="number-pad"
            placeholder="None"
            placeholderTextColor={faint}
            className="rounded-md border border-input bg-card px-3 py-2.5 font-mono text-[15px] text-foreground"
          />
          <Text className="text-xs text-faint">
            It stops when it has spent these tokens; empty, it has no limit.
          </Text>
        </View>
        {error ? (
          <Text className="text-sm text-destructive">{error}</Text>
        ) : null}
      </ScrollView>
    </View>
  );
}
