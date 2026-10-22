/** Projects' work as its actions give it. */

export type Status =
  | "backlog"
  | "todo"
  | "in_progress"
  | "in_review"
  | "done"
  | "cancelled";

export type Priority = "none" | "low" | "medium" | "high" | "urgent";

/** Where projects are: ZeroLux's own, or a tracker's workspace. */
export interface Source {
  id: string;
  name: string;
  tracker: string;
  config: Record<string, unknown>;
  /** ZeroLux's own, which stays. */
  own?: boolean;
  available: boolean;
  capabilities?: string[] | null;
  signed_in?: boolean;
  account?: string | null;
  error?: string | null;
}

/** A field a tracker asks for, to add a source of it. */
export interface Field {
  key: string;
  label: string;
  type: "text" | "secret" | "choice" | "boolean";
  required?: boolean;
  description?: string;
  options?: { value: string; label: string }[];
}

/** A tracker, as Projects lists them. */
export interface Tracker {
  tracker: string;
  title: string;
  description?: string;
  fields?: Field[];
  sign_in?: boolean;
  capabilities?: string[];
  error?: string;
}

export interface Project {
  id: string;
  source: string;
  key?: string;
  name: string;
  description?: string;
  archived: boolean;
  url?: string | null;
}

export interface Comment {
  id: string;
  /** Who of the workspace wrote it, here. */
  by: string | null;
  /** Who wrote it, in a tracker. */
  author?: string | null;
  text: string;
  at: number;
}

export interface Task {
  id: string;
  source: string;
  project_id: string;
  key: string;
  title: string;
  description: string;
  status: Status;
  priority: Priority;
  /** A person or an agent of the workspace; in a tracker, the agent ZeroLux gave it. */
  assignee: string | null;
  /** Who does it, in a tracker. */
  people?: string[];
  labels: string[];
  due: string | null;
  url: string | null;
  updated_at: number | null;
  /** Only when the task is read on its own. */
  comments?: Comment[];
}

/** Whether a source can do something. */
export const can = (source: Source | undefined, capability: string) =>
  Boolean(source?.capabilities?.includes(capability));

/** A source's state, in a few words; none when it is ready. */
export function sourceState(source: Source) {
  if (!source.available) return "Tracker not installed";
  if (source.signed_in === false) return "Not signed in";
  if (source.error) return source.error;
  return "";
}

/** What a person filled in for a tracker's fields: empty secrets are left as they were. */
export function filled(fields: Field[], values: Record<string, unknown>) {
  const config: Record<string, unknown> = {};
  for (const field of fields) {
    const value = values[field.key];
    if (field.type === "secret" && !String(value ?? "").trim()) continue;
    if (value !== undefined) config[field.key] = value;
  }
  return config;
}

/** The required fields still empty; changing a source, what it has counts as given. */
export function missing(
  fields: Field[],
  values: Record<string, unknown>,
  kept?: Record<string, unknown>,
) {
  return fields.filter(
    (field) =>
      field.required &&
      !String(values[field.key] ?? "").trim() &&
      !(kept && field.type === "secret") &&
      !String(kept?.[field.key] ?? "").trim(),
  );
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
  (b.updated_at ?? 0) - (a.updated_at ?? 0);

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
