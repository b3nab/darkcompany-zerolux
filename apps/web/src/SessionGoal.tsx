import { useState } from "react";
import {
  clearSessionGoal,
  goalStatusLabels,
  setSessionGoal,
  tokenCount,
  useSessionGoal,
} from "@zerolux/chat";
import type { ChatSession, GoalChange, LiveRead, Perform } from "@zerolux/chat";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";

/** How long a goal has been worked on: minutes, then hours and minutes. */
function duration(seconds: number) {
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  const rest = minutes % 60;
  return `${Math.floor(minutes / 60)} h${rest ? ` ${rest} min` : ""}`;
}

/** A goal as written: its objective, and a token budget when one is given. */
function GoalForm({
  initial,
  busy,
  save,
  cancel,
}: {
  initial: { objective: string; budget: string };
  busy: boolean;
  save: (change: GoalChange) => void;
  cancel: () => void;
}) {
  const [objective, setObjective] = useState(initial.objective);
  const [budget, setBudget] = useState(initial.budget);
  const tokens = budget.trim() ? Math.round(Number(budget)) : null;
  const valid =
    !!objective.trim() &&
    (tokens === null || (Number.isFinite(tokens) && tokens > 0));
  return (
    <form
      aria-label="Goal"
      className="flex flex-col gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        if (valid) save({ objective: objective.trim(), token_budget: tokens });
      }}
    >
      <Textarea
        aria-label="Objective"
        placeholder="What it works toward on its own, until it is done"
        value={objective}
        rows={3}
        autoFocus
        onChange={(event) => setObjective(event.target.value)}
        className="text-sm"
      />
      <label className="flex items-center gap-2 text-sm text-muted-foreground">
        Token budget
        <Input
          inputMode="numeric"
          aria-label="Token budget"
          placeholder="none"
          value={budget}
          onChange={(event) => setBudget(event.target.value)}
          className="h-7 w-32"
        />
      </label>
      <div className="flex gap-2">
        <Button type="submit" size="sm" disabled={busy || !valid}>
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
 * What a Codex session works toward on its own: its objective, where it stands and what it has
 * spent. Who may write to the session sets it, pauses, resumes, finishes or clears it.
 */
export function GoalCard({
  session,
  read,
  write,
  busy,
  perform,
}: {
  session: ChatSession;
  /** The session's live state, where its goal arrives. */
  read: (sessionId: string) => Promise<LiveRead>;
  write: boolean;
  busy: boolean;
  perform: Perform;
}) {
  const goal = useSessionGoal(session.id, read);
  const [editing, setEditing] = useState<{
    objective: string;
    budget: string;
  }>();
  const [clearing, setClearing] = useState(false);
  const change = (next: GoalChange) =>
    perform(async () => void (await setSessionGoal(session.id, next)));
  return (
    <section
      aria-label="Goal"
      className="flex flex-col gap-3 rounded-lg border p-3"
    >
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-sm font-medium">Goal</h3>
        {!goal && !editing && write && (
          <Button
            size="sm"
            variant="outline"
            onClick={() => setEditing({ objective: "", budget: "" })}
          >
            Set a goal
          </Button>
        )}
      </div>
      {editing ? (
        <GoalForm
          initial={editing}
          busy={busy}
          save={(next) =>
            void change(goal ? next : { ...next, status: "active" }).then(
              (done) => done && setEditing(undefined),
            )
          }
          cancel={() => setEditing(undefined)}
        />
      ) : goal ? (
        <>
          <p className="text-sm whitespace-pre-wrap">{goal.objective}</p>
          <p className="font-mono text-[11px] text-faint">
            <span
              className={
                goal.status === "active"
                  ? "text-agent-foreground"
                  : goal.status === "complete"
                    ? "text-success"
                    : goal.status === "paused"
                      ? undefined
                      : "text-attention"
              }
            >
              {goalStatusLabels[goal.status]}
            </span>
            {" · "}
            {tokenCount(goal.tokens_used)}
            {goal.token_budget !== null &&
              ` of ${tokenCount(goal.token_budget)}`}{" "}
            tokens · {duration(goal.time_used_seconds)}
          </p>
          {write && !clearing && (
            <div className="flex flex-wrap gap-1">
              {goal.status === "active" ? (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy}
                  onClick={() => void change({ status: "paused" })}
                >
                  Pause
                </Button>
              ) : (
                goal.status !== "complete" && (
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy}
                    onClick={() => void change({ status: "active" })}
                  >
                    Resume
                  </Button>
                )
              )}
              {goal.status !== "complete" && (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy}
                  onClick={() => void change({ status: "complete" })}
                >
                  Done
                </Button>
              )}
              <Button
                size="sm"
                variant="ghost"
                disabled={busy}
                onClick={() =>
                  setEditing({
                    objective: goal.objective,
                    budget: goal.token_budget?.toString() ?? "",
                  })
                }
              >
                Change
              </Button>
              <Button
                size="sm"
                variant="ghost"
                disabled={busy}
                onClick={() => setClearing(true)}
              >
                Clear
              </Button>
            </div>
          )}
          {clearing && (
            <div className="flex items-center gap-2 rounded-md bg-destructive/10 p-2 text-sm">
              <span className="flex-1">Clear this goal?</span>
              <Button
                size="sm"
                variant="destructive"
                disabled={busy}
                onClick={() =>
                  void perform(
                    async () => void (await clearSessionGoal(session.id)),
                  ).then((done) => done && setClearing(false))
                }
              >
                Clear
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() => setClearing(false)}
              >
                Keep it
              </Button>
            </div>
          )}
        </>
      ) : (
        <p className="text-sm text-muted-foreground">
          No goal. With one, Codex keeps working toward it on its own, turn
          after turn, until it is done or reaches its budget.
        </p>
      )}
    </section>
  );
}
