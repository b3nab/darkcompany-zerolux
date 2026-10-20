import { useCallback, useEffect, useRef, useState } from "react";
import { errorMessage, kernelUrl, request } from "./client";
import { spanLabel } from "./session-events";

/** A command a session runs in the background, in its folder on the kernel's computer. */
export interface Task {
  id: string;
  session_id: string;
  command: string;
  folder: string;
  status: "running" | "exited" | "stopped" | "lost";
  exit_code: number | null;
  started_at: number;
  ended_at: number | null;
  /** When the session was given how it ended. */
  told_at: number | null;
  error: string | null;
}

/** A piece of a task's output from an offset, and where to read on. */
export interface TaskOutput {
  start: number;
  text: string;
  next: number;
  /** How long the output is now. */
  end: number;
}

/** The kernel's notice that a task started, ended or was stopped. */
export interface TaskNotice {
  type: "task.changed";
  task_id: string;
  session_id: string;
  status: Task["status"];
}

const states: Record<Task["status"], string> = {
  running: "Running",
  exited: "Exited",
  stopped: "Stopped",
  lost: "Lost",
};

/** A task in a few words: how it stands, with its exit code, and how long it ran. */
export function taskState(task: Task, now = Date.now()) {
  const end = task.status === "running" ? now : task.ended_at;
  return [
    task.status === "exited" && task.exit_code !== null
      ? `Exited ${task.exit_code}`
      : states[task.status],
    end === null ? null : spanLabel(end - task.started_at),
  ]
    .filter(Boolean)
    .join(" · ");
}

/** How much of a task's output is kept to show: its end. */
const KEPT = 200_000;
/** How often a running task's output is read. */
const EVERY = 1000;

const listeners = new Map<string, Set<() => void>>();

/** A session's task changed: its lists read again. */
export function taskNotice(notice: TaskNotice) {
  listeners.get(notice.session_id)?.forEach((read) => read());
}

/** Notices may have been missed, as after a reconnection: every list reads again. */
export function tasksResync() {
  listeners.forEach((reads) => reads.forEach((read) => read()));
}

const sessionPath = (id: string) => `/sessions/${encodeURIComponent(id)}/tasks`;
const taskPath = (id: string) => `/tasks/${encodeURIComponent(id)}`;

/**
 * A session's tasks, newest first, read again when one changes; and its person's way to
 * start and stop them. Nothing is read without a session.
 */
export function useSessionTasks(
  sessionId: string | undefined,
  kernel = kernelUrl(),
) {
  const [read, setRead] = useState<{
    session: string;
    tasks?: Task[];
    error?: string;
  }>();
  const session = `${kernel}\n${sessionId}`;
  const reload = useCallback(
    async () =>
      sessionId === undefined
        ? undefined
        : request<{ tasks: Task[] }>(kernel, sessionPath(sessionId)).then(
            ({ tasks }) => setRead({ session, tasks }),
            (error: unknown) =>
              setRead((was) => ({
                ...(was?.session === session ? was : { session }),
                error: errorMessage(error),
              })),
          ),
    [kernel, sessionId, session],
  );
  useEffect(() => {
    if (sessionId === undefined) return;
    void reload();
    const read = () => void reload();
    const reads = listeners.get(sessionId) ?? new Set();
    reads.add(read);
    listeners.set(sessionId, reads);
    return () => {
      reads.delete(read);
      if (!reads.size) listeners.delete(sessionId);
    };
  }, [sessionId, reload]);
  const current = read?.session === session ? read : undefined;
  // The task as the kernel answered, once the list has it too.
  const andReload = async (work: Promise<{ task: Task }>) => {
    const { task } = await work;
    await reload();
    return task;
  };
  return {
    tasks: current?.tasks,
    error: current?.error ?? "",
    reload,
    start: (command: string) =>
      andReload(request(kernel, sessionPath(sessionId!), { command })),
    stop: (taskId: string) =>
      andReload(request(kernel, `${taskPath(taskId)}/stop`, {})),
  };
}

/** Where reading a task's output stands: the last part of it read, and the offset to go on. */
export interface TaskReading {
  text: string;
  next: number;
}

/**
 * Reads a task's output on from where `at` stands to the end there is now, in the kernel's
 * bounded pieces, keeping its last part.
 */
export async function readTaskOutput(
  taskId: string,
  at: TaskReading,
  kernel = kernelUrl(),
) {
  for (;;) {
    const { output } = await request<{ output: TaskOutput }>(
      kernel,
      `${taskPath(taskId)}?after=${at.next}`,
    );
    const moved = output.next > at.next;
    at.text = (at.text + output.text).slice(-KEPT);
    at.next = output.next;
    // A character cut at the end waits for the next read.
    if (!moved || output.next >= output.end) return at;
  }
}

/**
 * A task's output as it grows, its last part kept: read on every second while the task runs,
 * and once more when it has ended.
 */
export function useTaskOutput(
  taskId: string | undefined,
  running: boolean,
  kernel = kernelUrl(),
) {
  const key = `${kernel}\n${taskId}`;
  const [shown, setShown] = useState<{
    key: string;
    text: string;
    error?: string;
  }>();
  // Where reading goes on: kept across the end of the task, started over for another one.
  const reading = useRef({ key: "", text: "", next: 0 });
  useEffect(() => {
    if (taskId === undefined) return;
    if (reading.current.key !== key)
      reading.current = { key, text: "", next: 0 };
    const at = reading.current;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const readOn = async () => {
      try {
        await readTaskOutput(taskId, at, kernel);
        if (!stopped) setShown({ key, text: at.text });
      } catch (error) {
        if (!stopped)
          setShown({ key, text: at.text, error: errorMessage(error) });
      }
      if (running && !stopped) timer = setTimeout(() => void readOn(), EVERY);
    };
    void readOn();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [taskId, running, kernel, key]);
  const current = shown?.key === key ? shown : undefined;
  return { text: current?.text ?? "", error: current?.error ?? "" };
}
