import { kernelUrl, request } from "./client";

/** One of a plan's limits, as its provider's server gives it. */
export interface PlanLimit {
  /** `session`, `weekly_all` or `weekly_scoped`. */
  kind: string;
  /** `session` or `weekly`. */
  group: string;
  /** The model a scoped limit is for. */
  label: string | null;
  percent: number;
  /** When the window starts again, in milliseconds. */
  resets_at: number | null;
  /** The server's reading: `normal`, `warning` or `critical`; null when it gives none. */
  severity: string | null;
  /** The limit the server shows first; null when it says nothing. */
  active: boolean | null;
}

/** An earned reset of a plan's limits. */
export interface ResetCredit {
  id: string;
  title: string | null;
  description: string | null;
  expires_at: number | null;
}

/** A subscription of the person on the kernel's computer: how much of its plan is used. */
export interface Subscription {
  id: string;
  provider: "claude" | "chatgpt";
  /** The provider's own name for the plan: `max`, `pro`, `plus`… */
  plan: string | null;
  account: string | null;
  /** Whether the plan can be used now; null when unknown. */
  allowed: boolean | null;
  limits: PlanLimit[];
  /** Usage beyond the plan, in cents. */
  extra_usage: {
    enabled: boolean;
    used: number | null;
    limit: number | null;
    currency: string | null;
    percent: number | null;
  } | null;
  credits: { balance: string | null; unlimited: boolean } | null;
  resets: { available: number; credits: ResetCredit[] } | null;
  updated_at: number;
  error: string | null;
}

export type ResetOutcome =
  | "reset"
  | "nothing_to_reset"
  | "no_credit"
  | "already_redeemed";

export const providerNames: Record<Subscription["provider"], string> = {
  claude: "Claude",
  chatgpt: "ChatGPT",
};

/** The plan as people say it: `pro_lite` is "Pro Lite". */
export const planName = (plan: string | null) =>
  (plan ?? "")
    .split(/[_\s]+/)
    .filter(Boolean)
    .map((word) => word[0]!.toUpperCase() + word.slice(1))
    .join(" ");

/** A limit's name in a line: "Session", "Week", "Week · Opus". */
export const limitName = (limit: PlanLimit) =>
  [limit.group === "session" ? "Session" : "Week", limit.label]
    .filter(Boolean)
    .join(" · ");

/** The limit shown when only one is: the server's choice, else the nearest to its end. */
export const headline = (subscription: Subscription) =>
  subscription.limits.find((limit) => limit.active) ??
  [...subscription.limits].sort((a, b) => b.percent - a.percent)[0];

/** How near its end a limit is, as the server says or, when it does not, by its percentage. */
export const severityOf = (limit: PlanLimit) =>
  limit.severity ??
  (limit.percent >= 90
    ? "critical"
    : limit.percent >= 75
      ? "warning"
      : "normal");

const HOUR = 3_600_000;
const WINDOWS: Record<string, number> = {
  session: 5 * HOUR,
  weekly: 168 * HOUR,
};

/**
 * A week's use against an even pace: where it would be now, and when it runs out at this rate
 * if that comes before the reset. Nothing for a session, or before 3% of the week has passed.
 */
export function pace(limit: PlanLimit, now = Date.now()) {
  const span = WINDOWS[limit.group];
  if (limit.group !== "weekly" || !span || !limit.resets_at) return undefined;
  const elapsed = now - (limit.resets_at - span);
  if (elapsed < span * 0.03 || elapsed > span) return undefined;
  const expected = (elapsed / span) * 100;
  const end =
    limit.percent > 0
      ? now + ((100 - limit.percent) / limit.percent) * elapsed
      : Infinity;
  return { expected, runsOut: end < limit.resets_at ? end : undefined };
}

/** When a window starts again: "2h 10m" within a day, else "Mon 09:00". */
export function resetsIn(at: number, now = Date.now()) {
  const left = at - now;
  if (left <= 60_000) return "now";
  if (left < 24 * HOUR) {
    const hours = Math.floor(left / HOUR);
    const minutes = Math.floor((left % HOUR) / 60_000);
    return hours ? `${hours}h ${minutes}m` : `${minutes}m`;
  }
  return dayAndTime(at);
}

/** A moment within the week ahead: "Wed 21:00". */
export const dayAndTime = (at: number) =>
  new Intl.DateTimeFormat(undefined, {
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(at);

/** An amount in cents, in its currency. */
export const money = (cents: number, currency: string | null) =>
  new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: currency ?? "USD",
    maximumFractionDigits: 0,
  }).format(cents / 100);

/** The subscriptions of the person on the kernel's computer; `refresh` reads them again now. */
export const readSubscriptions = (kernel = kernelUrl(), refresh = false) =>
  request<{ subscriptions: Subscription[] }>(
    kernel,
    `/subscriptions${refresh ? "?refresh=true" : ""}`,
  ).then((r) => r.subscriptions);

/** Uses an earned reset, the one named or the next. */
export const redeemReset = (
  subscription: string,
  credit?: string,
  kernel = kernelUrl(),
) =>
  request<{ outcome: ResetOutcome }>(
    kernel,
    `/subscriptions/${encodeURIComponent(subscription)}/reset`,
    credit ? { credit_id: credit } : {},
  ).then((r) => r.outcome);
