import { useState } from "react";
import { ago, useSessionTriggers } from "@zerolux/chat";
import type { ChatSession, Perform, SessionTrigger } from "@zerolux/chat";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Textarea } from "@/components/ui/textarea";

/** What the session hears when CI ends: every result, or failures only, and the words after. */
export function TriggerForm({
  initial,
  busy,
  save,
  cancel,
}: {
  initial: { failures_only: boolean; prompt: string };
  busy: boolean;
  save: (change: { failures_only: boolean; prompt: string }) => void;
  cancel: () => void;
}) {
  const [failuresOnly, setFailuresOnly] = useState(initial.failures_only);
  const [prompt, setPrompt] = useState(initial.prompt);
  return (
    <form
      aria-label="When CI ends"
      className="flex flex-col gap-2 rounded-md border bg-card p-3"
      onSubmit={(event) => {
        event.preventDefault();
        save({ failures_only: failuresOnly, prompt: prompt.trim() });
      }}
    >
      <label className="flex items-center gap-2 text-sm">
        <Checkbox
          checked={failuresOnly}
          onCheckedChange={(checked) => setFailuresOnly(checked === true)}
        />
        Only failures
      </label>
      <Textarea
        aria-label="Prompt"
        placeholder="Fix what failed"
        value={prompt}
        rows={2}
        onChange={(event) => setPrompt(event.target.value)}
        className="text-sm"
      />
      <div className="flex gap-2">
        <Button type="submit" size="sm" disabled={busy}>
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
 * What the session hears when its commit's CI ends, through `gh` on the kernel's host: what is
 * watched, how the last check went, turned off and on, changed or removed.
 */
export function SessionTriggers({
  session,
  revision,
  busy,
  perform,
}: {
  session: ChatSession;
  revision: unknown;
  busy: boolean;
  perform: Perform;
}) {
  const { triggers, error, create, change, remove } = useSessionTriggers(
    session.id,
    revision,
  );
  // The trigger being written: a new one, or one changed by its ID.
  const [editing, setEditing] = useState<{
    id?: string;
    failures_only: boolean;
    prompt: string;
  }>();
  const [removing, setRemoving] = useState<string>();
  const row = (trigger: SessionTrigger) => (
    <li key={trigger.id} className="flex flex-col gap-2 py-2">
      <div className="flex items-start gap-3">
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <p className="text-sm font-medium">
            {trigger.failures_only ? "When CI fails" : "When CI ends"}
          </p>
          {trigger.prompt && (
            <p className="line-clamp-2 text-sm whitespace-pre-wrap text-muted-foreground">
              {trigger.prompt}
            </p>
          )}
          <p className="font-mono text-[11px] text-faint">
            {trigger.enabled ? "On" : "Off"}
            {trigger.last_run_at && ` · last heard ${ago(trigger.last_run_at)}`}
          </p>
          {trigger.last_error && (
            <p className="text-xs text-attention">{trigger.last_error}</p>
          )}
        </div>
        <div className="flex shrink-0 gap-1">
          <Button
            size="sm"
            variant="ghost"
            disabled={busy}
            onClick={() =>
              void perform(() =>
                change(trigger.id, { enabled: !trigger.enabled }),
              )
            }
          >
            {trigger.enabled ? "Turn off" : "Turn on"}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={busy}
            onClick={() =>
              setEditing({
                id: trigger.id,
                failures_only: trigger.failures_only,
                prompt: trigger.prompt,
              })
            }
          >
            Change
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={busy}
            onClick={() => setRemoving(trigger.id)}
          >
            Remove
          </Button>
        </div>
      </div>
      {removing === trigger.id && (
        <div className="flex items-center gap-2 rounded-md bg-destructive/10 p-2 text-sm">
          <span className="flex-1">Stop listening for CI?</span>
          <Button
            size="sm"
            variant="destructive"
            disabled={busy}
            onClick={() =>
              void perform(() => remove(trigger.id)).then(
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
  );
  return (
    <section
      aria-label="When CI ends"
      className="flex flex-col gap-3 rounded-lg border p-3"
    >
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-sm font-medium">When CI ends</h3>
        {!editing && !triggers?.length && (
          <Button
            size="sm"
            variant="outline"
            onClick={() =>
              setEditing({ failures_only: true, prompt: "Fix what failed." })
            }
          >
            Listen for CI
          </Button>
        )}
      </div>
      {error && <p className="text-xs text-attention">{error}</p>}
      {!!triggers?.length && (
        <ul className="flex flex-col divide-y">
          {triggers.map((trigger) =>
            editing?.id === trigger.id ? (
              <li key={trigger.id} className="py-2">
                <TriggerForm
                  initial={editing}
                  busy={busy}
                  save={(next) =>
                    void perform(() => change(trigger.id, next)).then(
                      (done) => done && setEditing(undefined),
                    )
                  }
                  cancel={() => setEditing(undefined)}
                />
              </li>
            ) : (
              row(trigger)
            ),
          )}
        </ul>
      )}
      {editing && editing.id === undefined && (
        <TriggerForm
          initial={editing}
          busy={busy}
          save={(next) =>
            void perform(() => create(next)).then(
              (done) => done && setEditing(undefined),
            )
          }
          cancel={() => setEditing(undefined)}
        />
      )}
    </section>
  );
}
