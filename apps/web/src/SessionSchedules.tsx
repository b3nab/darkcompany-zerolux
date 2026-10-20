import { useState } from "react";
import { PlusIcon } from "lucide-react";
import {
  ago,
  cronOf,
  ruleOf,
  scheduleEvery,
  scheduleWords,
  useSessionSchedules,
  weekdays,
} from "@zerolux/chat";
import type { ChatSession, Perform, ScheduleRule } from "@zerolux/chat";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  NativeSelect,
  NativeSelectOption,
} from "@/components/ui/native-select";
import { Textarea } from "@/components/ui/textarea";

/** When a schedule runs next: its day and time. */
const nextRun = (time: number) =>
  new Date(time).toLocaleString([], {
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });

const pad = (n: number) => String(n).padStart(2, "0");

/** A rule's time of day as a time field takes it, and back. */
const timeOf = (rule: { hour: number; minute: number }) =>
  `${pad(rule.hour)}:${pad(rule.minute)}`;
const fromTime = (value: string) => {
  const [hour = 0, minute = 0] = value.split(":").map(Number);
  return { hour, minute };
};

/** A new rule of a kind, keeping the time the last one had. */
function ruleFor(
  every: ScheduleRule["every"],
  was: ScheduleRule,
): ScheduleRule {
  const hour = "hour" in was ? was.hour : 9;
  const minute = "minute" in was ? was.minute : 0;
  switch (every) {
    case "hour":
      return { every, minute };
    case "day":
    case "weekday":
      return { every, hour, minute };
    case "week":
      return { every, day: 1, hour, minute };
    case "custom":
      return { every, cron: cronOf(was) };
  }
}

/** A schedule as the owner writes it: when, as a rule, and the words the session receives. */
export function ScheduleForm({
  initial,
  busy,
  save,
  cancel,
}: {
  initial: { rule: ScheduleRule; prompt: string };
  busy: boolean;
  save: (cron: string, prompt: string) => void;
  cancel: () => void;
}) {
  const [rule, setRule] = useState(initial.rule);
  const [prompt, setPrompt] = useState(initial.prompt);
  const cron = cronOf(rule);
  return (
    <form
      aria-label="Schedule"
      className="flex flex-col gap-2 rounded-md border bg-card p-3"
      onSubmit={(event) => {
        event.preventDefault();
        if (cron && prompt.trim()) save(cron, prompt.trim());
      }}
    >
      <div className="flex flex-wrap items-center gap-2">
        <NativeSelect
          size="sm"
          aria-label="When"
          value={rule.every}
          onChange={(event) =>
            setRule(ruleFor(event.target.value as ScheduleRule["every"], rule))
          }
        >
          {Object.entries(scheduleEvery).map(([every, label]) => (
            <NativeSelectOption key={every} value={every}>
              {label}
            </NativeSelectOption>
          ))}
        </NativeSelect>
        {rule.every === "week" && (
          <NativeSelect
            size="sm"
            aria-label="Day"
            value={rule.day}
            onChange={(event) =>
              setRule({ ...rule, day: Number(event.target.value) })
            }
          >
            {weekdays.map((day, i) => (
              <NativeSelectOption key={day} value={i}>
                {day}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        )}
        {rule.every === "hour" && (
          <label className="flex items-center gap-1.5 text-sm text-muted-foreground">
            at minute
            <Input
              type="number"
              aria-label="Minute"
              min={0}
              max={59}
              value={rule.minute}
              onChange={(event) =>
                setRule({
                  ...rule,
                  minute: Math.min(59, Math.max(0, Number(event.target.value))),
                })
              }
              className="h-7 w-16"
            />
          </label>
        )}
        {(rule.every === "day" ||
          rule.every === "weekday" ||
          rule.every === "week") && (
          <label className="flex items-center gap-1.5 text-sm text-muted-foreground">
            at
            <Input
              type="time"
              aria-label="Time"
              value={timeOf(rule)}
              onChange={(event) =>
                setRule({ ...rule, ...fromTime(event.target.value) })
              }
              className="h-7 w-28"
            />
          </label>
        )}
        {rule.every === "custom" && (
          <Input
            aria-label="Cron pattern"
            placeholder="minute hour day month weekday"
            value={rule.cron}
            onChange={(event) => setRule({ ...rule, cron: event.target.value })}
            className="h-7 min-w-0 flex-1 font-mono text-[12.5px]"
          />
        )}
      </div>
      <Textarea
        aria-label="Prompt"
        placeholder="Prompt"
        value={prompt}
        rows={3}
        onChange={(event) => setPrompt(event.target.value)}
        className="text-sm"
      />
      <p className="text-xs text-faint">{scheduleWords(cron)}</p>
      <div className="flex gap-2">
        <Button
          type="submit"
          size="sm"
          disabled={busy || !cron || !prompt.trim()}
        >
          Save
        </Button>
        <Button type="button" size="sm" variant="outline" onClick={cancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

/**
 * Words the owner has the session receive on a schedule: each one's when, words, next run and
 * how the last went; turned off and on, changed, or removed.
 */
export function SessionSchedules({
  session,
  busy,
  perform,
}: {
  session: ChatSession;
  busy: boolean;
  perform: Perform;
}) {
  const { schedules, error, create, change, remove } = useSessionSchedules(
    session.id,
  );
  // The schedule being written: a new one, or one changed by its ID.
  const [editing, setEditing] = useState<{
    id?: string;
    rule: ScheduleRule;
    prompt: string;
  }>();
  const [removing, setRemoving] = useState<string>();
  return (
    <section
      aria-label="Schedules"
      className="flex flex-col gap-3 rounded-lg border p-3"
    >
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-sm font-medium">Schedules</h3>
        {!editing && (
          <Button
            size="sm"
            variant="outline"
            onClick={() =>
              setEditing({
                rule: { every: "weekday", hour: 9, minute: 0 },
                prompt: "",
              })
            }
          >
            <PlusIcon data-icon="inline-start" />
            New schedule
          </Button>
        )}
      </div>
      {error && <p className="text-xs text-attention">{error}</p>}
      {schedules?.length === 0 && !editing && (
        <p className="text-sm text-muted-foreground">Nothing scheduled.</p>
      )}
      {!!schedules?.length && (
        <ul className="flex flex-col divide-y">
          {schedules.map((schedule) =>
            editing?.id === schedule.id ? (
              <li key={schedule.id} className="py-2">
                <ScheduleForm
                  initial={editing}
                  busy={busy}
                  save={(cron, prompt) =>
                    void perform(() =>
                      change(schedule.id, { cron, prompt }),
                    ).then((done) => done && setEditing(undefined))
                  }
                  cancel={() => setEditing(undefined)}
                />
              </li>
            ) : (
              <li key={schedule.id} className="flex flex-col gap-2 py-2">
                <div className="flex items-start gap-3">
                  <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <p className="text-sm font-medium">
                      {scheduleWords(schedule.cron)}
                    </p>
                    <p className="line-clamp-2 text-sm whitespace-pre-wrap text-muted-foreground">
                      {schedule.prompt}
                    </p>
                    <p className="font-mono text-[11px] text-faint">
                      {schedule.enabled && schedule.next_run_at
                        ? `Next ${nextRun(schedule.next_run_at)}`
                        : "Off"}
                      {schedule.last_run_at &&
                        ` · last ran ${ago(schedule.last_run_at)}`}
                    </p>
                    {schedule.last_error && (
                      <p className="text-xs text-attention">
                        {schedule.last_error}
                      </p>
                    )}
                  </div>
                  <div className="flex shrink-0 gap-1">
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={busy}
                      onClick={() =>
                        void perform(() =>
                          change(schedule.id, { enabled: !schedule.enabled }),
                        )
                      }
                    >
                      {schedule.enabled ? "Turn off" : "Turn on"}
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={busy}
                      onClick={() =>
                        setEditing({
                          id: schedule.id,
                          rule: ruleOf(schedule.cron),
                          prompt: schedule.prompt,
                        })
                      }
                    >
                      Change
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={busy}
                      onClick={() => setRemoving(schedule.id)}
                    >
                      Remove
                    </Button>
                  </div>
                </div>
                {removing === schedule.id && (
                  <div className="flex items-center gap-2 rounded-md bg-destructive/10 p-2 text-sm">
                    <span className="flex-1">Remove this schedule?</span>
                    <Button
                      size="sm"
                      variant="destructive"
                      disabled={busy}
                      onClick={() =>
                        void perform(() => remove(schedule.id)).then(
                          (done) => done && setRemoving(undefined),
                        )
                      }
                    >
                      Remove
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => setRemoving(undefined)}
                    >
                      Keep it
                    </Button>
                  </div>
                )}
              </li>
            ),
          )}
        </ul>
      )}
      {editing && editing.id === undefined && (
        <ScheduleForm
          initial={editing}
          busy={busy}
          save={(cron, prompt) =>
            void perform(() => create(cron, prompt)).then(
              (done) => done && setEditing(undefined),
            )
          }
          cancel={() => setEditing(undefined)}
        />
      )}
    </section>
  );
}
