/** Commands a session runs in the background: it goes on, and is told how each ends. */
type Call = <T>(path: string, body?: unknown) => Promise<T>;

export interface Task {
  id: string;
  session_id: string;
  command: string;
  folder: string;
  status: "running" | "exited" | "stopped" | "lost";
  exit_code: number | null;
  started_at: number;
  ended_at: number | null;
  told_at: number | null;
  error: string | null;
}

/** What a tool returns of a task's output at most, from where it reads. */
const READ = 16 * 1024;

export async function startTask(call: Call, session: string, command: string) {
  const { task } = await call<{ task: Task }>(
    `/sessions/${encodeURIComponent(session)}/tasks`,
    { command },
  );
  return task;
}

export async function listTasks(call: Call, session: string) {
  const { tasks } = await call<{ tasks: Task[] }>(
    `/sessions/${encodeURIComponent(session)}/tasks`,
  );
  return tasks;
}

/** A task and its output from `after`; without it, the end of its output. */
export async function readTask(call: Call, id: string, after?: number) {
  const path = `/tasks/${encodeURIComponent(id)}`;
  let read = await call<{
    task: Task;
    output: { start: number; text: string; next: number; end: number };
  }>(`${path}?after=${after ?? 0}`);
  if (after === undefined && read.output.end > READ)
    read = await call(`${path}?after=${read.output.end - READ}`);
  const text =
    read.output.text.length > READ
      ? read.output.text.slice(0, READ)
      : read.output.text;
  return {
    status: read.task.status,
    exit_code: read.task.exit_code,
    command: read.task.command,
    output: text,
    from: read.output.start,
    next: read.output.start + Buffer.byteLength(text),
    end: read.output.end,
  };
}

export async function stopTask(call: Call, id: string) {
  const { task } = await call<{ task: Task }>(
    `/tasks/${encodeURIComponent(id)}/stop`,
    {},
  );
  return task;
}
