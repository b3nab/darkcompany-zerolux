import { useEffect, useRef, useState } from "react";
import { PlusIcon } from "lucide-react";
import {
  backgroundState,
  plainOutput,
  useBackgroundCommands,
  useBackgroundOutput,
} from "@zerolux/chat";
import type { BackgroundCommand, Perform } from "@zerolux/chat";
import { Pane } from "./SessionCode";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

/** How a background command stands; while it runs, its time counted live. */
function State({ command }: { command: BackgroundCommand }) {
  const running = command.status === "running";
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [running]);
  return <>{backgroundState(command, now)}</>;
}

/** A background command's output, following its end while it runs unless scrolled up. */
function Output({ command }: { command: BackgroundCommand }) {
  const { text, error } = useBackgroundOutput(
    command.id,
    command.status === "running",
  );
  const view = useRef<HTMLPreElement>(null);
  const following = useRef(true);
  useEffect(() => {
    if (following.current && view.current)
      view.current.scrollTop = view.current.scrollHeight;
  }, [text]);
  return (
    <>
      {error && <p className="text-xs text-attention">{error}</p>}
      <pre
        ref={view}
        onScroll={({ currentTarget: pre }) => {
          following.current =
            pre.scrollHeight - pre.scrollTop - pre.clientHeight < 8;
        }}
        className="max-h-64 overflow-auto rounded-md bg-muted p-2 font-mono text-[12px] break-all whitespace-pre-wrap"
      >
        {plainOutput(text) || "No output."}
      </pre>
    </>
  );
}

/** Commands the session runs in the background: started, followed and stopped here. */
export function BackgroundPanel({
  background: { commands, error, run, stop },
  write,
  busy,
  perform,
  close,
}: {
  background: ReturnType<typeof useBackgroundCommands>;
  write: boolean;
  busy: boolean;
  perform: Perform;
  close: () => void;
}) {
  // The command being written; undefined while there is no form.
  const [draft, setDraft] = useState<string>();
  const [open, setOpen] = useState<string>();
  return (
    <Pane
      title="Background"
      close={close}
      actions={
        write &&
        draft === undefined && (
          <Button size="sm" variant="outline" onClick={() => setDraft("")}>
            <PlusIcon data-icon="inline-start" />
            Run in background
          </Button>
        )
      }
    >
      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-3">
        {draft !== undefined && (
          <form
            className="flex gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              void perform(async () => {
                setOpen((await run(draft.trim())).id);
              }).then((done) => done && setDraft(undefined));
            }}
          >
            <Input
              aria-label="Command"
              placeholder="bun test"
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              autoFocus
              className="h-7 min-w-0 flex-1 font-mono text-[12.5px]"
            />
            <Button type="submit" size="sm" disabled={busy || !draft.trim()}>
              Start
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => setDraft(undefined)}
            >
              Cancel
            </Button>
          </form>
        )}
        {error && <p className="text-xs text-attention">{error}</p>}
        {commands?.length === 0 && draft === undefined && (
          <p className="text-sm text-muted-foreground">
            No background commands.
          </p>
        )}
        {!!commands?.length && (
          <ul className="flex flex-col divide-y">
            {commands.map((command) => (
              <li key={command.id} className="flex flex-col gap-2 py-2">
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    aria-expanded={open === command.id}
                    title={command.command}
                    onClick={() =>
                      setOpen(open === command.id ? undefined : command.id)
                    }
                    className="min-w-0 flex-1 truncate text-left font-mono text-[12.5px]"
                  >
                    {command.command}
                  </button>
                  <span className="shrink-0 font-mono text-[11px] text-faint">
                    <State command={command} />
                  </span>
                  {write && command.status === "running" && (
                    <Button
                      size="xs"
                      variant="outline"
                      disabled={busy}
                      onClick={() =>
                        void perform(async () => {
                          await stop(command.id);
                        })
                      }
                    >
                      Stop
                    </Button>
                  )}
                </div>
                {command.error && (
                  <p className="text-xs text-attention">{command.error}</p>
                )}
                {open === command.id && <Output command={command} />}
              </li>
            ))}
          </ul>
        )}
      </div>
    </Pane>
  );
}
