import { useEffect, useRef, useState } from "react";
import { PlusIcon } from "lucide-react";
import {
  plainOutput,
  taskState,
  useSessionTasks,
  useTaskOutput,
} from "@zerolux/chat";
import type { Perform, Task } from "@zerolux/chat";
import { Pane } from "./SessionCode";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

/** How a task stands; while it runs, its time counted live. */
function State({ task }: { task: Task }) {
  const running = task.status === "running";
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [running]);
  return <>{taskState(task, now)}</>;
}

/** A task's output, following its end while it runs unless scrolled up. */
function TaskOutput({ task }: { task: Task }) {
  const { text, error } = useTaskOutput(task.id, task.status === "running");
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
export function TasksPanel({
  tasks: { tasks, error, start, stop },
  write,
  busy,
  perform,
  close,
}: {
  tasks: ReturnType<typeof useSessionTasks>;
  write: boolean;
  busy: boolean;
  perform: Perform;
  close: () => void;
}) {
  // The command being written; undefined while there is no form.
  const [command, setCommand] = useState<string>();
  const [open, setOpen] = useState<string>();
  return (
    <Pane
      title="Tasks"
      close={close}
      actions={
        write &&
        command === undefined && (
          <Button size="sm" variant="outline" onClick={() => setCommand("")}>
            <PlusIcon data-icon="inline-start" />
            New task
          </Button>
        )
      }
    >
      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-3">
        {command !== undefined && (
          <form
            className="flex gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              void perform(async () => {
                setOpen((await start(command.trim())).id);
              }).then((done) => done && setCommand(undefined));
            }}
          >
            <Input
              aria-label="Command"
              placeholder="bun test"
              value={command}
              onChange={(event) => setCommand(event.target.value)}
              autoFocus
              className="h-7 min-w-0 flex-1 font-mono text-[12.5px]"
            />
            <Button type="submit" size="sm" disabled={busy || !command.trim()}>
              Start
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => setCommand(undefined)}
            >
              Cancel
            </Button>
          </form>
        )}
        {error && <p className="text-xs text-attention">{error}</p>}
        {tasks?.length === 0 && command === undefined && (
          <p className="text-sm text-muted-foreground">No tasks.</p>
        )}
        {!!tasks?.length && (
          <ul className="flex flex-col divide-y">
            {tasks.map((task) => (
              <li key={task.id} className="flex flex-col gap-2 py-2">
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    aria-expanded={open === task.id}
                    title={task.command}
                    onClick={() =>
                      setOpen(open === task.id ? undefined : task.id)
                    }
                    className="min-w-0 flex-1 truncate text-left font-mono text-[12.5px]"
                  >
                    {task.command}
                  </button>
                  <span className="shrink-0 font-mono text-[11px] text-faint">
                    <State task={task} />
                  </span>
                  {write && task.status === "running" && (
                    <Button
                      size="xs"
                      variant="outline"
                      disabled={busy}
                      onClick={() =>
                        void perform(async () => {
                          await stop(task.id);
                        })
                      }
                    >
                      Stop
                    </Button>
                  )}
                </div>
                {task.error && (
                  <p className="text-xs text-attention">{task.error}</p>
                )}
                {open === task.id && <TaskOutput task={task} />}
              </li>
            ))}
          </ul>
        )}
      </div>
    </Pane>
  );
}
