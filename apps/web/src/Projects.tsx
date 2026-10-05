import { useEffect, useState } from "react";
import type { SubmitEvent } from "react";
import { useSearchParams } from "react-router";
import { cn } from "cn";
import {
  actionsFor,
  activeActors,
  actorLabel,
  api,
  errorMessage,
  labels,
  statuses,
} from "./api";
import type {
  Action,
  Actor,
  Project,
  Run,
  Status,
  Task,
  Workspace,
} from "./api";
import type { Perform } from "@zerolux/chat";
import { ByohPanel } from "./ByohPanel";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  NativeSelect,
  NativeSelectOption,
} from "@/components/ui/native-select";
import { Textarea } from "@/components/ui/textarea";
import { Page } from "@/components/page";
import { Eyebrow } from "@/components/presence";

const date = (value: number) => new Date(value).toLocaleString();
// Agents' work glows in the agent light; what waits for a person, in the attention color.
const statusDot: Record<Status, string> = {
  draft: "bg-transparent ring-1 ring-faint ring-inset",
  queued: "bg-faint",
  running: "animate-pulse rounded-[1.5px] bg-agent ring-3 ring-agent/20",
  review: "bg-attention",
  done: "bg-success",
  failed: "bg-destructive",
};
const statusText: Record<Status, string> = {
  draft: "text-muted-foreground",
  queued: "text-muted-foreground",
  running: "text-agent-foreground",
  review: "text-attention",
  done: "text-success",
  failed: "text-destructive",
};

/** A project's task board, a form for the next task, and the selected task. */
export function ProjectPage({
  workspace,
  project,
  busy,
  perform,
  hire,
}: {
  workspace: Workspace;
  project?: Project;
  busy: boolean;
  perform: Perform;
  hire: () => void;
}) {
  // The address names the open task, so other pages can link to it.
  const [params, setParams] = useSearchParams();
  const taskId = params.get("task") ?? "";
  const setTaskId = (task: string) => setParams({ task }, { replace: true });
  const [agentId, setAgentId] = useState("");
  const actors = activeActors(workspace.actors);
  const agents = actors.filter((a) => a.kind === "agent");
  const agent = agents.find((a) => a.id === agentId) ?? agents[0];
  const tasks = workspace.tasks.filter((t) => t.project_id === project?.id);
  const selected = tasks.find((t) => t.id === taskId) ?? tasks[0];

  async function createTask(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!project || !agent) return;
    const form = event.currentTarget;
    const data = new FormData(form);
    const ok = await perform(async () => {
      const task = await api<Task>("/tasks", {
        project_id: project.id,
        title: data.get("title"),
        description: data.get("description"),
        assignee_id: agent.id,
      });
      setTaskId(task.id);
    });
    if (ok) form.reset();
  }

  const byoh = (
    <ByohPanel
      workspace={workspace}
      project={project}
      agent={agent}
      selectAgent={setAgentId}
      hire={hire}
    />
  );
  if (!project)
    return (
      <Page>
        {byoh}
        <div className="flex flex-col gap-3 py-16">
          <Eyebrow>Day −1</Eyebrow>
          <h1 className="text-4xl font-semibold tracking-tight">
            Build the company
            <br />
            that builds itself.
          </h1>
          <p className="text-muted-foreground">
            Create your first project to begin the loop.
            <br />
            Nothing runs until you queue a task and start a worker.
          </p>
        </div>
      </Page>
    );
  const done = tasks.filter((t) => t.status === "done").length;
  return (
    <Page>
      {byoh}
      <section className="flex flex-wrap items-end justify-between gap-6">
        <div className="flex flex-col gap-2">
          <Eyebrow>Project / {project.id.slice(0, 8)}</Eyebrow>
          <h1 className="text-3xl font-semibold tracking-tight">
            {project.name}
          </h1>
          <p className="text-muted-foreground">
            {project.description ||
              "Your first human + agent development loop."}
          </p>
        </div>
        <div className="flex flex-col items-end max-lg:hidden">
          <strong className="text-3xl font-semibold">
            {done}
            <span className="text-muted-foreground"> / {tasks.length}</span>
          </strong>
          <Eyebrow>Tasks approved</Eyebrow>
        </div>
      </section>
      <section className="flex items-center gap-4 rounded-xl border bg-card p-4">
        <span className="font-mono text-xs text-muted-foreground max-lg:hidden">
          01 → 05
        </span>
        <div>
          <strong className="text-sm font-semibold">
            Create. Queue. Execute. Review. Repeat.
          </strong>
          <p className="text-sm text-muted-foreground">
            Select an agent when creating a task. Queue it explicitly, then use
            the BYOH connection instructions above.
          </p>
        </div>
      </section>
      <div className="flex items-center justify-between">
        <Eyebrow>Task board</Eyebrow>
        <Eyebrow>
          {tasks.length} task{tasks.length === 1 ? "" : "s"} · live
        </Eyebrow>
      </div>
      <section
        aria-label="Task board"
        className="grid gap-3 sm:grid-cols-3 xl:grid-cols-6"
      >
        {statuses.map((status) => {
          const column = tasks.filter((t) => t.status === status);
          return (
            <div
              key={status}
              data-status={status}
              className="flex flex-col gap-2 rounded-xl bg-muted/40 p-2"
            >
              <div className="flex items-center gap-2 px-1 text-xs font-medium">
                <span
                  aria-hidden
                  className={cn("size-1.5 rounded-full", statusDot[status])}
                />
                {labels[status]}
                <span className="ml-auto text-muted-foreground">
                  {column.length}
                </span>
              </div>
              {column.map((task) => (
                <button
                  key={task.id}
                  aria-pressed={task.id === selected?.id}
                  onClick={() => setTaskId(task.id)}
                  className="flex flex-col gap-1 rounded-lg border bg-card p-3 text-left text-sm transition-colors hover:bg-accent aria-pressed:border-primary/60"
                >
                  <span className="font-mono text-[11px] text-faint">
                    {task.id.slice(0, 8)}
                  </span>
                  <strong className="font-medium">{task.title}</strong>
                  <span className="font-mono text-xs text-agent-foreground">
                    ↳{" "}
                    {actorLabel(
                      workspace.actors.find((a) => a.id === task.assignee_id),
                    )}
                  </span>
                </button>
              ))}
              {column.length === 0 && (
                <span className="px-1 py-2 text-center text-xs text-muted-foreground">
                  —
                </span>
              )}
            </div>
          );
        })}
      </section>
      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <Eyebrow>New task</Eyebrow>
            <CardTitle>Give the agent a clear goal.</CardTitle>
          </CardHeader>
          <CardContent>
            <form
              key={project.id}
              onSubmit={(e) => void createTask(e)}
              className="flex flex-col gap-4"
            >
              <div className="flex flex-col gap-2">
                <Label htmlFor="task-title">Title</Label>
                <Input
                  id="task-title"
                  name="title"
                  placeholder="Add the first dogfooding improvement"
                  required
                  maxLength={200}
                />
              </div>
              <div className="flex flex-col gap-2">
                <Label htmlFor="task-description">
                  Description & acceptance criteria
                </Label>
                <Textarea
                  id="task-description"
                  name="description"
                  placeholder="Scope, constraints, and how we will verify the result…"
                  rows={6}
                  maxLength={20000}
                />
              </div>
              <div className="flex flex-col gap-2">
                <Label htmlFor="task-assignee">Assigned agent</Label>
                <NativeSelect
                  id="task-assignee"
                  name="assignee_id"
                  className="w-full"
                  value={agent?.id ?? ""}
                  onChange={(e) => setAgentId(e.target.value)}
                  required
                >
                  {agents.length === 0 && (
                    <NativeSelectOption value="">
                      Hire an agent first
                    </NativeSelectOption>
                  )}
                  {agents.map((a) => (
                    <NativeSelectOption key={a.id} value={a.id}>
                      {a.name}
                      {a.harness ? ` · ${a.harness}` : " · custom/demo"}
                    </NativeSelectOption>
                  ))}
                </NativeSelect>
              </div>
              <div className="flex flex-wrap items-center justify-between gap-3">
                <span className="text-xs text-muted-foreground">
                  {agent
                    ? `Owned by ${actors.find((a) => a.id === agent.owner_id)?.name}`
                    : "Hire an agent in BYOH before creating a task."}
                </span>
                <Button type="submit" disabled={busy || !agent}>
                  Create draft
                </Button>
              </div>
            </form>
          </CardContent>
        </Card>
        {selected ? (
          <TaskDetail
            key={selected.id}
            task={selected}
            busy={busy}
            actors={workspace.actors}
            reassign={(assignee_id) =>
              perform(async () => {
                await api(`/tasks/${selected.id}/assignee`, { assignee_id });
              })
            }
            act={(action, note) =>
              perform(async () => {
                await api(`/tasks/${selected.id}/actions`, { action, note });
              })
            }
          />
        ) : (
          <Card>
            <CardHeader>
              <Eyebrow>Human in the loop</Eyebrow>
              <CardTitle>Every result has a reviewer.</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-sm text-muted-foreground">
                Agent output will appear here. A successful run is only a
                proposal: you decide when the task is done.
              </p>
            </CardContent>
          </Card>
        )}
      </div>
    </Page>
  );
}

function TaskDetail({
  task,
  busy,
  act,
  actors,
  reassign,
}: {
  task: Task;
  busy: boolean;
  actors: Actor[];
  reassign: (actorId: string) => Promise<boolean>;
  act: (action: Action, note: string) => Promise<boolean>;
}) {
  const [runs, setRuns] = useState<Run[]>([]);
  const [error, setError] = useState("");
  const [note, setNote] = useState("");
  const [replacementId, setReplacementId] = useState("");
  const retired =
    actors.find((a) => a.id === task.assignee_id)?.archived === true;
  const replacements = activeActors(actors).filter((a) => a.kind === "agent");
  const replacement =
    replacements.find((a) => a.id === replacementId) ?? replacements[0];
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    async function load() {
      try {
        const data = await api<Run[]>(
          `/tasks/${task.id}/runs`,
          undefined,
          controller.signal,
        );
        if (!controller.signal.aborted) {
          setRuns(data);
          setError("");
        }
      } catch (error) {
        if (!controller.signal.aborted) setError(errorMessage(error));
      }
      if (!controller.signal.aborted && task.status === "running")
        timer = setTimeout(load, 2000);
    }
    void load();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [task.id, task.status, task.updated_at]);
  const actions = actionsFor(task.status).filter(
    (action) => !retired || action === "approve",
  );
  const notice = "rounded-lg bg-attention/10 p-3 text-sm text-attention";
  return (
    <Card>
      <CardHeader className="gap-3">
        <div className="flex items-center justify-between gap-3">
          <Eyebrow>Task / {task.id.slice(0, 8)}</Eyebrow>
          <span
            data-status={task.status}
            className={cn(
              "rounded-full bg-muted px-2 py-0.5 text-xs font-medium",
              statusText[task.status],
            )}
          >
            {labels[task.status]}
          </span>
        </div>
        <CardTitle>{task.title}</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <p className="text-sm whitespace-pre-wrap text-muted-foreground">
          {task.description || "No description provided."}
        </p>
        {retired && task.status !== "done" && (
          <div className="flex flex-col gap-3 rounded-lg bg-muted/50 p-3 text-sm">
            <p>
              This task belongs to a retired agent. Its runs and results are
              kept.
            </p>
            {task.status === "running" ? (
              <p>
                Wait for the active run to finish or expire before reassigning
                it.
              </p>
            ) : (
              <>
                <div className="flex flex-col gap-2">
                  <Label htmlFor="replacement">Assign to a hired agent</Label>
                  <NativeSelect
                    id="replacement"
                    className="w-full"
                    value={replacement?.id ?? ""}
                    onChange={(event) => setReplacementId(event.target.value)}
                    disabled={busy || !replacement}
                  >
                    {!replacement && (
                      <NativeSelectOption value="">
                        Hire an agent first
                      </NativeSelectOption>
                    )}
                    {replacements.map((a) => (
                      <NativeSelectOption key={a.id} value={a.id}>
                        {a.name}
                      </NativeSelectOption>
                    ))}
                  </NativeSelect>
                </div>
                <p className="text-muted-foreground">
                  Reassignment returns the task to draft. Review its existing
                  changes and explicitly queue it again.
                </p>
                <Button
                  variant="outline"
                  className="self-start"
                  disabled={busy || !replacement}
                  onClick={() => {
                    if (replacement) void reassign(replacement.id);
                  }}
                >
                  Assign & return to draft
                </Button>
              </>
            )}
          </div>
        )}
        {task.review_note && (
          <blockquote className="border-l-2 border-primary/50 pl-3 text-sm">
            <strong className="font-medium">Latest human feedback</strong>
            <p className="text-muted-foreground">{task.review_note}</p>
          </blockquote>
        )}
        {task.status === "queued" && !retired && (
          <p className="text-sm text-muted-foreground">
            Waiting for a worker. Queueing does not start a process by itself.
          </p>
        )}
        {task.status === "running" && (
          <p className="text-sm text-muted-foreground">
            The worker is running. Output is collected when the process
            finishes.
          </p>
        )}
        {task.status === "review" && (
          <p className={notice}>
            Inspect the actual diff and run the tests in the worktree before
            approving. Approval does not commit or merge code.
          </p>
        )}
        {task.status === "failed" && (
          <p className={notice}>
            The worktree may contain partial changes. Inspect it before
            retrying.
          </p>
        )}
        {(task.status === "review" || task.status === "failed") && (
          <div className="flex flex-col gap-2">
            <Label htmlFor="review-note">Human feedback</Label>
            <Textarea
              id="review-note"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              rows={3}
              maxLength={20000}
              placeholder="Required when requesting changes"
            />
          </div>
        )}
        {actions.length > 0 && (
          <div className="flex flex-wrap gap-2">
            {actions.map((action) => (
              <Button
                key={action}
                variant={action === "request_changes" ? "outline" : "default"}
                disabled={
                  busy || (action === "request_changes" && !note.trim())
                }
                onClick={() =>
                  void act(action, note).then((ok) => {
                    if (ok) setNote("");
                  })
                }
              >
                {action === "approve"
                  ? "Approve & complete"
                  : action === "request_changes"
                    ? "Request changes & queue"
                    : task.status === "failed"
                      ? "Retry task"
                      : "Queue for execution"}
              </Button>
            ))}
          </div>
        )}
        <div className="flex items-center justify-between border-t pt-4">
          <Eyebrow>Run history</Eyebrow>
          <span className="font-mono text-xs text-muted-foreground">
            {runs.length}
          </span>
        </div>
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        {runs.length === 0 && (
          <p className="text-sm text-muted-foreground">
            No runs yet. Drafts never execute automatically.
          </p>
        )}
        {runs.map((run, index) => (
          <details
            key={run.id}
            open={index === 0}
            className="rounded-lg border p-3 text-sm"
          >
            <summary className="flex cursor-pointer justify-between gap-3 font-medium">
              <span>{run.status}</span>
              <time className="text-xs text-muted-foreground">
                {date(run.started_at)}
              </time>
            </summary>
            <div className="mt-3 flex flex-col gap-2">
              <p className="font-mono text-xs text-muted-foreground">
                Run {run.id.slice(0, 8)} · exit {run.exit_code ?? "—"}
                {run.actor_id && (
                  <>
                    {" "}
                    · {actorLabel(actors.find((a) => a.id === run.actor_id))}
                  </>
                )}
                {run.connection_id && (
                  <> · connection {run.connection_id.slice(0, 8)}</>
                )}
              </p>
              {run.failure_reason && (
                <p className="text-destructive">{run.failure_reason}</p>
              )}
              {run.stdout && (
                <>
                  <h4 className="text-xs font-semibold">Standard output</h4>
                  <pre className="max-h-80 overflow-auto rounded-md bg-muted p-3 font-mono text-xs">
                    {run.stdout}
                  </pre>
                </>
              )}
              {run.stderr && (
                <>
                  <h4 className="text-xs font-semibold">Standard error</h4>
                  <pre className="max-h-80 overflow-auto rounded-md bg-muted p-3 font-mono text-xs">
                    {run.stderr}
                  </pre>
                </>
              )}
              {!run.stdout && !run.stderr && (
                <p className="text-muted-foreground">No captured output.</p>
              )}
            </div>
          </details>
        ))}
      </CardContent>
    </Card>
  );
}
