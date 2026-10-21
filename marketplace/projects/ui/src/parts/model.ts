/** Projects' work as its actions give it. */

export type Status =
  | "backlog"
  | "todo"
  | "in_progress"
  | "in_review"
  | "done"
  | "cancelled";

export type Priority = "none" | "low" | "medium" | "high" | "urgent";

export interface Project {
  id: string;
  key: string;
  name: string;
  description: string;
  tracker: string | null;
  archived: boolean;
}

export interface Comment {
  id: string;
  by: string | null;
  text: string;
  at: number;
}

export interface Task {
  id: string;
  key: string;
  number: number;
  project_id: string;
  title: string;
  description: string;
  status: Status;
  priority: Priority;
  assignee: string | null;
  labels: string[];
  due: string | null;
  url: string | null;
  updated_at: number;
  /** Only when the task is read on its own. */
  comments?: Comment[];
}

/** An action run from a tap: what went wrong shows in its `error`, nothing more is thrown. */
export const tap = (work: Promise<unknown>) => void work.catch(() => undefined);

/** Each state with its label and icon, in the order work goes. */
export const statuses: { value: Status; label: string; icon: string }[] = [
  { value: "backlog", label: "Backlog", icon: "circle-dashed" },
  { value: "todo", label: "Todo", icon: "circle" },
  { value: "in_progress", label: "In progress", icon: "contrast" },
  { value: "in_review", label: "In review", icon: "circle-dot" },
  { value: "done", label: "Done", icon: "circle-check" },
  { value: "cancelled", label: "Cancelled", icon: "circle-x" },
];

/** Each priority with its label and icon, the most pressing first. */
export const priorities: { value: Priority; label: string; icon: string }[] = [
  { value: "urgent", label: "Urgent", icon: "octagon-alert" },
  { value: "high", label: "High", icon: "signal-high" },
  { value: "medium", label: "Medium", icon: "signal-medium" },
  { value: "low", label: "Low", icon: "signal-low" },
  { value: "none", label: "No priority", icon: "minus" },
];

export const statusOf = (value: Status) =>
  statuses.find((s) => s.value === value) ?? statuses[0]!;

export const priorityOf = (value: Priority) =>
  priorities.find((p) => p.value === value) ?? priorities[4]!;

/** Work still to do, as opposed to done or dropped. */
export const open = (task: Task) =>
  task.status !== "done" && task.status !== "cancelled";

const rank = (priority: Priority) =>
  priorities.findIndex((p) => p.value === priority);

/** The most pressing first, then the soonest due, then the latest changed. */
export const byUrgency = (a: Task, b: Task) =>
  rank(a.priority) - rank(b.priority) ||
  (a.due ?? "9999").localeCompare(b.due ?? "9999") ||
  b.updated_at - a.updated_at;

/** Tasks by state, each group in order of urgency. */
export const byStatus = (tasks: Task[]) =>
  statuses.map((status) => ({
    ...status,
    tasks: tasks.filter((t) => t.status === status.value).sort(byUrgency),
  }));

/** Every label the tasks carry, once, in order. */
export const labelsOf = (tasks: Task[]) =>
  [...new Set(tasks.flatMap((t) => t.labels))].sort((a, b) =>
    a.localeCompare(b),
  );

/** A day as `YYYY-MM-DD`, read in the local calendar. */
const day = (date: Date) =>
  `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;

/** A due date as people read it: today, tomorrow, or the day. */
export function dueLabel(due: string, now = new Date()) {
  const today = day(now);
  const tomorrow = day(new Date(now.getTime() + 86_400_000));
  if (due === today) return "Today";
  if (due === tomorrow) return "Tomorrow";
  const [year, month, date] = due.split("-").map(Number);
  return new Date(year!, month! - 1, date).toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
    ...(year === now.getFullYear() ? {} : { year: "numeric" }),
  });
}

/** How a due day reads: red from the day it is due, amber in the week before. */
export function dueTone(task: Task, now = new Date()) {
  if (!open(task) || !task.due) return "default";
  if (task.due <= day(now)) return "danger";
  return task.due <= day(new Date(now.getTime() + 7 * 86_400_000))
    ? "warning"
    : "default";
}

/** When something happened, as a short time: today's hour, or the day. */
export function when(at: number, now = new Date()) {
  const date = new Date(at);
  return day(date) === day(now)
    ? date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })
    : date.toLocaleDateString(undefined, { day: "numeric", month: "short" });
}

/** A key for a new project from its name: its initials, or its first letters. */
export function keyFrom(name: string) {
  const words = name
    .toUpperCase()
    .replace(/[^A-Z0-9 ]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
  const key =
    words.length > 1
      ? words.map((w) => w[0]).join("")
      : (words[0] ?? "").slice(0, 3);
  return /^[A-Z]/.test(key) ? key.slice(0, 10) : "";
}
