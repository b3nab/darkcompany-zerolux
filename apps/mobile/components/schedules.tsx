import { useState } from "react";
import {
  Alert,
  Pressable,
  ScrollView,
  Switch,
  TextInput,
  View,
} from "react-native";
import { useCSSVariable } from "uniwind";
import {
  clockTime,
  cronOf,
  dayLabel,
  errorMessage,
  ruleOf,
  scheduleEvery,
  scheduleWords,
  useSessionSchedules,
  weekdays,
} from "@zerolux/chat";
import type { ChatSession, Schedule, ScheduleRule } from "@zerolux/chat";
import { PageSheet } from "@/components/page-sheet";
import { SettingSelect } from "@/components/setting-select";
import { TimeField } from "@/components/time-field";
import { Text } from "@/components/ui/text";
import { cn } from "@/lib/utils";
import { useSession } from "../src/kernel";
import { useAccess } from "../src/me";

/**
 * In About, for whoever works in the session: the words it receives on a schedule, each with when it
 * runs next and how the last run went, on or off with a switch; a tap changes one.
 */
export function Schedules({ session }: { session: ChatSession }) {
  const { url } = useSession();
  const { write } = useAccess(session);
  const schedules = useSessionSchedules(write ? session.id : undefined, url);
  const [editing, setEditing] = useState<Schedule | "new">();
  const [error, setError] = useState("");
  if (!write) return null;
  const act = (work: Promise<unknown>) => {
    setError("");
    work.catch((e: unknown) => setError(errorMessage(e)));
  };
  const list = schedules.schedules ?? [];
  return (
    <View className="gap-2">
      <View className="flex-row items-center justify-between">
        <Text className="text-sm text-faint">Schedules</Text>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Add a schedule"
          onPress={() => setEditing("new")}
          hitSlop={8}
        >
          <Text className="text-sm font-medium text-human-foreground">Add</Text>
        </Pressable>
      </View>
      {error || schedules.error ? (
        <Text className="text-xs text-destructive">
          {error || schedules.error}
        </Text>
      ) : null}
      {list.length ? (
        <View className="overflow-hidden rounded-md border border-border">
          {list.map((schedule, index) => (
            <Pressable
              key={schedule.id}
              accessibilityRole="button"
              onPress={() => setEditing(schedule)}
              className={cn(
                "flex-row items-center gap-3 bg-card px-3 py-2.5 active:bg-accent",
                index > 0 && "border-t border-border",
              )}
            >
              <View className="min-w-0 flex-1 gap-0.5">
                <Text
                  className={cn(
                    "text-[15px] font-medium",
                    !schedule.enabled && "text-muted-foreground",
                  )}
                >
                  {scheduleWords(schedule.cron)}
                </Text>
                <Text
                  numberOfLines={2}
                  className="text-[13px] text-muted-foreground"
                >
                  {schedule.prompt}
                </Text>
                <Text className="text-xs text-faint">
                  {schedule.enabled && schedule.next_run_at
                    ? `Next: ${dayLabel(schedule.next_run_at)} at ${clockTime(schedule.next_run_at)}`
                    : "Off"}
                </Text>
                {schedule.last_error ? (
                  <Text className="text-xs text-attention">
                    Last run missed: {schedule.last_error}
                  </Text>
                ) : null}
              </View>
              <Switch
                accessibilityLabel={scheduleWords(schedule.cron)}
                value={schedule.enabled}
                onValueChange={(enabled) =>
                  act(schedules.change(schedule.id, { enabled }))
                }
              />
            </Pressable>
          ))}
        </View>
      ) : schedules.schedules ? (
        <Text className="text-xs text-faint">Nothing scheduled.</Text>
      ) : null}
      <PageSheet
        open={editing !== undefined}
        onClose={() => setEditing(undefined)}
      >
        {editing !== undefined ? (
          <ScheduleForm
            schedule={editing === "new" ? undefined : editing}
            save={(cron, prompt) =>
              editing === "new"
                ? schedules.create(cron, prompt)
                : schedules.change(editing.id, { cron, prompt })
            }
            remove={
              editing === "new" ? undefined : () => schedules.remove(editing.id)
            }
            close={() => setEditing(undefined)}
          />
        ) : null}
      </PageSheet>
    </View>
  );
}

/** The rule's time of day, where it has one; else 09:00. */
const timeOf = (rule: ScheduleRule) =>
  "hour" in rule
    ? { hour: rule.hour, minute: rule.minute }
    : { hour: 9, minute: 0 };

/**
 * A schedule's when and what: how often, at what time (on what day, for every week) or a
 * cron pattern of one's own, and the words to send.
 */
function ScheduleForm({
  schedule,
  save,
  remove,
  close,
}: {
  schedule?: Schedule;
  save: (cron: string, prompt: string) => Promise<unknown>;
  remove?: () => Promise<unknown>;
  close: () => void;
}) {
  const faint = String(useCSSVariable("--color-faint"));
  const [rule, setRule] = useState<ScheduleRule>(() =>
    schedule ? ruleOf(schedule.cron) : { every: "day", hour: 9, minute: 0 },
  );
  const [prompt, setPrompt] = useState(schedule?.prompt ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const time = timeOf(rule);
  const day = rule.every === "week" ? rule.day : 1;
  const cron = cronOf(rule);
  // Each kind keeps the time chosen; a custom one starts from what the others say.
  const choose = (every: ScheduleRule["every"]) =>
    setRule(
      every === "custom"
        ? { every, cron }
        : every === "hour"
          ? { every, minute: time.minute }
          : every === "week"
            ? { every, day, ...time }
            : { every, ...time },
    );
  const setTime = (hour: number, minute: number) =>
    setRule((was) =>
      was.every === "hour"
        ? { ...was, minute }
        : was.every === "custom"
          ? was
          : { ...was, hour, minute },
    );
  const run = async (work: () => Promise<unknown>) => {
    setBusy(true);
    setError("");
    try {
      await work();
      close();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  const ready = Boolean(prompt.trim() && cron);
  return (
    <View className="flex-1 bg-background">
      <View className="flex-row items-center justify-between border-b border-border px-5 py-3">
        <Pressable accessibilityRole="button" onPress={close} hitSlop={12}>
          <Text className="text-base text-muted-foreground">Cancel</Text>
        </Pressable>
        <Text className="text-[17px] font-semibold">
          {schedule ? "Schedule" : "New schedule"}
        </Text>
        <Pressable
          accessibilityRole="button"
          disabled={busy || !ready}
          onPress={() => void run(() => save(cron, prompt.trim()))}
          hitSlop={12}
          className="disabled:opacity-40"
        >
          <Text className="text-base font-medium text-human-foreground">
            Save
          </Text>
        </Pressable>
      </View>
      <ScrollView
        contentContainerClassName="gap-5 px-5 py-5"
        keyboardDismissMode="interactive"
      >
        <SettingSelect
          label="Repeat"
          value={rule.every}
          options={scheduleEvery}
          onChange={(value) => choose(value as ScheduleRule["every"])}
        />
        {rule.every === "week" ? (
          <SettingSelect
            label="Day"
            value={String(rule.day)}
            options={Object.fromEntries(
              weekdays.map((name, index) => [String(index), name]),
            )}
            onChange={(value) => setRule({ ...rule, day: Number(value) })}
          />
        ) : null}
        {rule.every === "custom" ? (
          <View className="gap-2">
            <Text className="text-sm font-medium">Cron pattern</Text>
            <TextInput
              value={rule.cron}
              onChangeText={(text) => setRule({ every: "custom", cron: text })}
              autoCorrect={false}
              autoCapitalize="none"
              placeholder="*/30 9-18 * * 1-5"
              placeholderTextColor={faint}
              className="rounded-md border border-input bg-card px-3 py-2.5 font-mono text-[15px] text-foreground"
            />
            <Text className="text-xs text-faint">
              Minute, hour, day of the month, month and day of the week.
            </Text>
          </View>
        ) : (
          <View className="flex-row items-center justify-between">
            <Text className="text-sm font-medium">
              {rule.every === "hour" ? "Minute" : "Time"}
            </Text>
            <TimeField
              hour={time.hour}
              minute={time.minute}
              minuteOnly={rule.every === "hour"}
              change={setTime}
            />
          </View>
        )}
        <View className="gap-2">
          <Text className="text-sm font-medium">What to send</Text>
          <TextInput
            value={prompt}
            onChangeText={setPrompt}
            multiline
            placeholder="Check the build and tell me what broke"
            placeholderTextColor={faint}
            textAlignVertical="top"
            className="min-h-32 rounded-md border border-input bg-card px-3 py-2.5 font-sans text-[15px] leading-[21px] text-foreground"
          />
          {cron ? (
            <Text className="text-xs text-faint">{scheduleWords(cron)}</Text>
          ) : null}
        </View>
        {error ? (
          <Text className="text-sm text-destructive">{error}</Text>
        ) : null}
        {remove ? (
          <Pressable
            accessibilityRole="button"
            disabled={busy}
            onPress={() =>
              Alert.alert("Delete this schedule?", undefined, [
                { text: "Cancel", style: "cancel" },
                {
                  text: "Delete",
                  style: "destructive",
                  onPress: () => void run(remove),
                },
              ])
            }
            className="self-start py-2"
          >
            <Text className="text-[15px] text-destructive">
              Delete schedule
            </Text>
          </Pressable>
        ) : null}
      </ScrollView>
    </View>
  );
}
