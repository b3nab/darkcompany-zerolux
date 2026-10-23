import { useEffect, useMemo, useRef, useState } from "react";
import {
  CheckIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  SquareArrowOutUpRightIcon,
} from "lucide-react";
import {
  ApiError,
  AuthConnection,
  briefAgo,
  connectRealtime,
  dayAndTime,
  errorMessage,
  harnessLabels,
  headline,
  limitName,
  money,
  pace,
  permissionShown,
  planName,
  providerNames,
  questionsOf,
  readSubscriptions,
  redeemReset,
  request,
  requiresSignIn,
  resetsIn,
  scopeLabels,
  scopesOf,
  setKernelUrl,
  severityOf,
  useUiPieces,
  whoAmI,
} from "@zerolux/chat";
import type {
  Actor,
  Approval,
  ApprovalScope,
  ChatSession,
  PlanLimit,
  Subscription,
  Workspace,
} from "@zerolux/chat";
import { cn } from "cn";
import {
  onTray,
  trayCredential,
  trayHide,
  trayNewWindow,
  trayNotify,
  trayOpen,
  trayReport,
  trayResize,
  trayWorkspaces,
} from "./tray";
import type { TrayReport, TrayWorkspace } from "./tray";
import { Mark } from "./components/brand";
import { ExtensionView } from "./extension-view";
import { ActorMark } from "./components/presence";
import { Button } from "./components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "./components/ui/dropdown-menu";
import { Kbd } from "./components/ui/kbd";

/** A workspace as the panel hears it. */
interface Heard {
  live: boolean;
  actors: Actor[];
  sessions: ChatSession[];
  /** What its sessions ask of you, oldest first. */
  approvals: Approval[];
  /** None where its kernel has no subscriptions to give. */
  subscriptions?: Subscription[];
  error?: string;
}

/** A request with the workspace it comes from. */
export interface Waiting {
  workspace: TrayWorkspace;
  approval: Approval;
  agent: string;
  session?: ChatSession;
}

const SUBSCRIPTIONS_EVERY = 5 * 60_000;
const notFound = (error: unknown) =>
  error instanceof ApiError && error.status === 404;

/**
 * One workspace's kernel, heard with its sign-in: its people and agents, its sessions, the
 * requests of the sessions that are yours, and the subscriptions of its computer.
 */
function Hear({
  workspace,
  attempt,
  heard,
}: {
  workspace: TrayWorkspace;
  /** Grows when the panel opens: a workspace that could not be heard is tried again. */
  attempt: number;
  heard: (profile: string, state: Heard) => void;
}) {
  const { kernel, profile, workspace: id } = workspace;
  useEffect(() => {
    let stopped = false;
    let state: Heard = { live: false, actors: [], sessions: [], approvals: [] };
    let me: string | undefined;
    const set = (next: Partial<Heard>) => {
      state = { ...state, ...next };
      if (!stopped) heard(profile, state);
    };
    const mine = (approvals: Approval[], sessions: ChatSession[]) =>
      approvals
        .filter(
          (approval) =>
            approval.status === "pending" &&
            sessions.find((s) => s.id === approval.session_id)?.owner_id === me,
        )
        .sort((a, b) => a.created_at - b.created_at);
    const readSessions = () =>
      request<{ sessions: ChatSession[] }>(kernel, "/sessions").then(
        ({ sessions }) => sessions,
      );
    const readApprovals = () =>
      request<{ approvals: Approval[] }>(kernel, "/chat/approvals").then(
        ({ approvals }) => approvals,
      );
    const readPlans = () =>
      readSubscriptions(kernel).then(
        (subscriptions) => set({ subscriptions }),
        (error: unknown) =>
          notFound(error) && set({ subscriptions: undefined }),
      );
    // Signed in as the workspace's own window is; the panel never signs in or out.
    const connection = new AuthConnection(kernel, id ?? undefined, {
      read: (_, workspace) => trayCredential(profile, workspace),
      write: async () => {},
    });
    async function readAll() {
      try {
        const { health, identity } = await connection.restore();
        if (requiresSignIn(health) && !identity) {
          set({ approvals: [], error: "Sign in from its window" });
          return;
        }
        const [{ actors }, sessions, approvals] = await Promise.all([
          request<Workspace>(kernel, "/workspace"),
          readSessions(),
          readApprovals(),
        ]);
        me = whoAmI(identity, actors, requiresSignIn(health)).me?.id;
        set({
          actors,
          sessions,
          approvals: mine(approvals, sessions),
          error: undefined,
        });
      } catch (error) {
        set({ error: errorMessage(error) });
      }
      await readPlans();
    }
    async function readRequests() {
      try {
        const [sessions, approvals] = await Promise.all([
          readSessions(),
          readApprovals(),
        ]);
        set({
          sessions,
          approvals: mine(approvals, sessions),
          error: undefined,
        });
      } catch (error) {
        set({ error: errorMessage(error) });
      }
    }
    void readAll();
    const plans = setInterval(() => void readPlans(), SUBSCRIPTIONS_EVERY);
    const stop = connectRealtime({
      kernel,
      event: (event) => {
        if (
          event.type === "approval.changed" ||
          event.type === "session.changed"
        )
          void readRequests();
        else if (event.type === "subscriptions.changed")
          set({ subscriptions: event.subscriptions });
      },
      sync: () => void readAll(),
      status: (status) => set({ live: status === "live" }),
    });
    return () => {
      stopped = true;
      clearInterval(plans);
      stop();
    };
    // `heard` only reports.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kernel, profile, id, attempt]);
  return null;
}

/** Where a request is answered in the app: its chat, else its session. */
const pageOf = (approval: Approval) =>
  approval.conversation_id
    ? `/chats/${approval.conversation_id}`
    : `/console/${approval.session_id}`;

/** A question answered with one tap: one question, one answer among its options. */
const quickAnswers = (approval: Approval) => {
  const questions = questionsOf(approval);
  const [only] = questions;
  return questions.length === 1 && only && !only.multiple && only.options.length
    ? only.options.map((option) => option.label)
    : undefined;
};

const shortScopes: Record<ApprovalScope, string> = {
  once: "Allow once",
  session: "This session",
  always: "Always",
};

/** What can be answered without opening the app, as Linux's menu offers it. */
export function choicesOf(approval: Approval) {
  if (approval.kind === "permission")
    return [
      ...scopesOf(approval).map((scope) => ({
        id: scope,
        label: scopeLabels[scope],
      })),
      { id: "deny", label: "Deny" },
    ];
  return (quickAnswers(approval) ?? []).map((label, at) => ({
    id: `answer:${at}`,
    label,
  }));
}

export function TrayRequest({
  waiting,
  focused,
  answer,
  open,
}: {
  waiting: Waiting;
  focused: boolean;
  answer: (choice: string) => void;
  open: () => void;
}) {
  const { approval, agent, session } = waiting;
  const shown =
    approval.kind === "permission" ? permissionShown(approval) : undefined;
  const answers = quickAnswers(approval);
  const question = questionsOf(approval)[0];
  return (
    <article
      data-request={approval.id}
      tabIndex={-1}
      className="mx-2 mb-1.5 rounded-[10px] border bg-card p-2.5 outline-none focus:border-warning/45"
    >
      <button
        type="button"
        onClick={open}
        className="flex w-full min-w-0 items-center gap-2 text-left text-[13px]"
      >
        <ActorMark kind="agent" name={agent} className="size-6 text-[10px]" />
        <span className="shrink-0 font-medium text-agent-foreground">
          {agent}
        </span>
        <span className="min-w-0 truncate">
          {shown?.wants ??
            (approval.kind === "question" ? "asks" : "needs an answer")}
        </span>
        <span className="ml-auto shrink-0 text-[11.5px] text-faint">
          {[
            session && harnessLabels[session.harness],
            briefAgo(approval.created_at, Date.now()),
          ]
            .filter(Boolean)
            .join(" · ")}
        </span>
      </button>
      <div className="mt-1.5 mb-2 flex flex-col gap-1 text-[12.5px] text-muted-foreground">
        {shown?.command && (
          <pre className="rounded-md border bg-background px-2 py-1.5 font-mono text-[11.5px] break-all whitespace-pre-wrap text-foreground">
            {shown.command}
          </pre>
        )}
        {shown?.cwd && <span>in {shown.cwd}</span>}
        {shown?.files?.map((file) => (
          <span key={file.path} className="flex gap-2 font-mono text-[11.5px]">
            <span className="min-w-0 flex-1 truncate">{file.path}</span>
            {file.added !== undefined && (
              <span className="text-success">+{file.added}</span>
            )}
            {file.removed !== undefined && (
              <span className="text-destructive">−{file.removed}</span>
            )}
          </span>
        ))}
        {(shown?.text ?? (question?.question || approval.summary)) && (
          <span className="line-clamp-3 break-words">
            {shown ? shown.text : question?.question || approval.summary}
          </span>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        {approval.kind === "permission" ? (
          <>
            {scopesOf(approval).map((scope) => (
              <Button
                key={scope}
                size="xs"
                variant={scope === "once" ? "default" : "outline"}
                onClick={() => answer(scope)}
              >
                {shortScopes[scope]}
                {focused && scope === "once" && (
                  <Kbd className="h-4 bg-transparent">⏎</Kbd>
                )}
              </Button>
            ))}
            <Button
              size="xs"
              variant="ghost"
              className="ml-auto"
              onClick={() => answer("deny")}
            >
              Deny
              {focused && <Kbd className="h-4 bg-transparent">⌫</Kbd>}
            </Button>
          </>
        ) : (
          <>
            {answers?.map((label, at) => (
              <Button
                key={label}
                size="xs"
                variant="outline"
                onClick={() => answer(`answer:${at}`)}
              >
                {label}
              </Button>
            ))}
            <Button
              size="xs"
              variant={answers ? "ghost" : "default"}
              onClick={open}
            >
              {answers ? "Other…" : "Answer…"}
            </Button>
          </>
        )}
      </div>
    </article>
  );
}

function Meter({ limit, now }: { limit: PlanLimit; now: number }) {
  const severity = severityOf(limit);
  const expected = pace(limit, now)?.expected;
  return (
    <div className="grid grid-cols-[80px_minmax(0,1fr)_36px_70px] items-center gap-2 py-0.5 text-xs">
      <span className="truncate text-muted-foreground">{limitName(limit)}</span>
      <span className="relative h-[5px] rounded-full bg-input/60">
        <span
          className={cn(
            "absolute inset-y-0 left-0 rounded-full",
            severity === "critical"
              ? "bg-destructive"
              : severity === "warning"
                ? "bg-warning"
                : "bg-foreground/85",
          )}
          style={{ width: `${Math.min(100, limit.percent)}%` }}
        />
        {expected !== undefined && (
          <span
            className="absolute -inset-y-0.5 w-px bg-muted-foreground"
            style={{ left: `${expected}%` }}
          />
        )}
      </span>
      <span className="text-right tabular-nums">
        {Math.round(limit.percent)}%
      </span>
      <span className="text-right text-faint tabular-nums">
        {limit.resets_at ? resetsIn(limit.resets_at, now) : ""}
      </span>
    </div>
  );
}

/** A plan: its main limit, and a click away the others, its pace, extra usage and resets. */
export function TrayPlan({
  subscription,
  kernel,
  now,
}: {
  subscription: Subscription;
  kernel: string;
  now: number;
}) {
  const [open, setOpen] = useState(false);
  const [error, setError] = useState("");
  const main = headline(subscription);
  const weekly = subscription.limits.filter((limit) => pace(limit, now));
  const extra = subscription.extra_usage;
  const resets = subscription.resets?.available ?? 0;
  return (
    <div className="mx-2 mb-1.5 rounded-[10px] border bg-card px-3 py-2.5">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className="mb-1.5 flex w-full items-baseline gap-1.5 text-left text-[13px]"
      >
        <span className="font-medium">
          {providerNames[subscription.provider]}
        </span>
        <span className="text-[11.5px] text-faint">
          {planName(subscription.plan)}
        </span>
        <ChevronRightIcon
          aria-hidden
          className={cn(
            "ml-auto size-3 self-center text-faint transition-transform",
            open && "rotate-90",
          )}
        />
      </button>
      {subscription.allowed === false && (
        <p className="mb-1 text-xs text-destructive">Limit reached</p>
      )}
      {(open ? subscription.limits : main ? [main] : []).map((limit) => (
        <Meter key={`${limit.kind}:${limit.label}`} limit={limit} now={now} />
      ))}
      {open && (
        <div className="mt-1 flex flex-col gap-1 text-[11.5px] text-faint">
          {weekly.map((limit) => {
            const runsOut = pace(limit, now)?.runsOut;
            return (
              <span
                key={limit.kind + limit.label}
                className={cn(runsOut && "text-warning")}
              >
                {limitName(limit)}:{" "}
                {runsOut
                  ? `runs out ${dayAndTime(runsOut)}`
                  : "lasts until reset"}
              </span>
            );
          })}
          {extra?.enabled && extra.used !== null && (
            <span>
              Extra usage {money(extra.used, extra.currency)}
              {extra.limit !== null &&
                ` of ${money(extra.limit, extra.currency)}`}{" "}
              this month
            </span>
          )}
          {subscription.credits && (
            <span>
              Credits{" "}
              {subscription.credits.unlimited
                ? "unlimited"
                : (subscription.credits.balance ?? "none")}
            </span>
          )}
          {resets > 0 && (
            <span className="flex items-center gap-2">
              {resets === 1
                ? "1 reset available"
                : `${resets} resets available`}
              <Button
                size="xs"
                variant="outline"
                className="ml-auto"
                onClick={() => {
                  setError("");
                  redeemReset(subscription.id, undefined, kernel).catch(
                    (e: unknown) => setError(errorMessage(e)),
                  );
                }}
              >
                Use
              </Button>
            </span>
          )}
          {error && <span className="text-destructive">{error}</span>}
        </div>
      )}
    </div>
  );
}

/** The rows the workspace's extensions bring to the panel, such as the next meeting. */
function TrayRows({ kernel }: { kernel: string }) {
  const pieces = useUiPieces("tray", kernel);
  return pieces.map((piece) => (
    <div
      key={`${piece.extension}/${piece.name}`}
      className="mx-2 mb-1.5 rounded-[10px] border bg-card px-3 py-2.5 text-[12.5px]"
    >
      <ExtensionView piece={piece} context={{}} />
    </div>
  ));
}

const Label = ({ children, count }: { children: string; count?: number }) => (
  <div className="flex items-baseline justify-between px-3.5 pt-2.5 pb-1.5 font-mono text-[10.5px] font-medium tracking-[0.06em] text-faint uppercase">
    <span>{children}</span>
    {!!count && <span className="text-warning">{count}</span>}
  </div>
);

/**
 * The tray's panel: what every open workspace asks of you, answered here or opened in the app,
 * and how much of each subscription is used. It stays loaded while hidden, so the mark and the
 * menu always say what waits.
 */
export function TrayPanel() {
  const [workspaces, setWorkspaces] = useState<TrayWorkspace[]>([]);
  const [heard, setHeard] = useState<Record<string, Heard>>({});
  const [focus, setFocus] = useState(0);
  const [attempts, setAttempts] = useState<Record<string, number>>({});
  const [error, setError] = useState("");
  const [now, setNow] = useState(Date.now());
  const panel = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const read = () =>
      trayWorkspaces().then(setWorkspaces, (e: unknown) =>
        setError(errorMessage(e)),
      );
    void read();
    const ticking = setInterval(() => setNow(Date.now()), 30_000);
    const stop = onTray("zerolux-tray-workspaces", () => void read());
    return () => {
      clearInterval(ticking);
      stop();
    };
  }, []);

  const active = workspaces.find((w) => w.active) ?? workspaces[0];
  // Extensions' rows read the workspace in front, as its own pages read theirs.
  setKernelUrl(active?.kernel ?? "");
  // The workspace in front first, then the others in their order.
  const ordered = useMemo(
    () =>
      [...workspaces].sort(
        (a, b) => Number(b === active) - Number(a === active),
      ),
    [workspaces, active],
  );
  const waiting: Waiting[] = ordered.flatMap((workspace) => {
    const state = heard[workspace.profile];
    return (state?.approvals ?? []).map((approval) => ({
      workspace,
      approval,
      agent:
        state?.actors.find((a) => a.id === approval.actor_id)?.name ??
        "An agent",
      session: state?.sessions.find((s) => s.id === approval.session_id),
    }));
  });
  // Each subscription once, however many workspaces of this computer give it.
  const plans = [
    ...new Map(
      ordered.flatMap((workspace) =>
        (heard[workspace.profile]?.subscriptions ?? []).map(
          (subscription) =>
            [
              subscription.id,
              { subscription, kernel: workspace.kernel },
            ] as const,
        ),
      ),
    ).values(),
  ];
  const live = ordered.some((w) => heard[w.profile]?.live);
  const focused = Math.min(focus, Math.max(0, waiting.length - 1));

  async function answer(item: Waiting, choice: string) {
    const { approval, workspace } = item;
    setError("");
    try {
      if (choice.startsWith("answer:")) {
        const question = questionsOf(approval)[0]!;
        const label = quickAnswers(approval)![Number(choice.slice(7))]!;
        await request(
          workspace.kernel,
          `/chat/approvals/${approval.id}/answer`,
          {
            answers: { [question.id]: [label] },
          },
        );
      } else
        await request(
          workspace.kernel,
          `/chat/approvals/${approval.id}/decision`,
          choice === "deny"
            ? { decision: "deny" }
            : { decision: "allow", scope: choice },
        );
    } catch (e) {
      setError(errorMessage(e));
    }
  }
  const open = (item: Waiting) =>
    void trayOpen(item.workspace.profile, pageOf(item.approval));

  // The mark and Linux's menu say what waits.
  const report: TrayReport = {
    live,
    requests: waiting.map(({ workspace, approval, agent }) => {
      const shown =
        approval.kind === "permission" ? permissionShown(approval) : undefined;
      const what = shown?.command ?? shown?.files?.[0]?.path ?? shown?.text;
      return {
        profile: workspace.profile,
        id: approval.id,
        title:
          `${agent} ${shown?.wants ?? "asks"}${what ? `: ${what}` : ""}`.slice(
            0,
            80,
          ),
        choices: choicesOf(approval),
      };
    }),
    plans: plans.flatMap(({ subscription }) => {
      const main = headline(subscription);
      return main
        ? [
            `${providerNames[subscription.provider]} ${planName(subscription.plan)} · ${limitName(main)} ${Math.round(main.percent)}%${main.resets_at ? ` · ${resetsIn(main.resets_at, now)}` : ""}`,
          ]
        : [];
    }),
  };
  const reported = JSON.stringify(report);
  useEffect(() => {
    void trayReport(report).catch(() => {});
    // The report's text decides.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reported]);

  // A request that comes while the panel is closed is also a notification, answered from it.
  // What already waits when a workspace is first heard is not news.
  const known = useRef(new Map<string, Set<string>>());
  useEffect(() => {
    for (const workspace of ordered) {
      const state = heard[workspace.profile];
      if (!state || state.error) continue;
      const before = known.current.get(workspace.profile);
      known.current.set(
        workspace.profile,
        new Set(state.approvals.map((approval) => approval.id)),
      );
      if (!before || document.hasFocus()) continue;
      for (const item of waiting) {
        if (item.workspace !== workspace || before.has(item.approval.id))
          continue;
        const { approval } = item;
        const shown =
          approval.kind === "permission"
            ? permissionShown(approval)
            : undefined;
        const body =
          shown?.command ??
          shown?.files?.map((file) => file.path).join("\n") ??
          shown?.text ??
          (questionsOf(approval)[0]?.question || approval.summary);
        void trayNotify({
          profile: workspace.profile,
          id: approval.id,
          title: `${item.agent} ${shown?.wants ?? "asks"}`,
          subtitle: workspace.name,
          body,
          choices: approval.kind === "permission",
        }).catch(() => {});
      }
    }
    // What was heard decides.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [heard]);

  // Answers chosen in Linux's menu or a notification, and requests opened from them.
  const latest = useRef(waiting);
  latest.current = waiting;
  const latestHeard = useRef(heard);
  latestHeard.current = heard;
  useEffect(() => {
    const find = ({ profile, id }: { profile: string; id: string }) =>
      latest.current.find(
        (w) => w.workspace.profile === profile && w.approval.id === id,
      );
    const stops = [
      onTray<{ profile: string; id: string; choice: string }>(
        "zerolux-tray-choose",
        (chosen) => {
          const item = find(chosen);
          if (item) void answer(item, chosen.choice);
        },
      ),
      onTray<{ profile: string; id: string }>(
        "zerolux-tray-request",
        (opened) => {
          const item = find(opened);
          if (item) open(item);
        },
      ),
      // Opened from the mark: the first request takes the keyboard.
      onTray("zerolux-tray-shown", () => {
        setFocus(0);
        setAttempts((all) => {
          const next = { ...all };
          for (const [profile, state] of Object.entries(latestHeard.current))
            if (state.error) next[profile] = (next[profile] ?? 0) + 1;
          return next;
        });
        requestAnimationFrame(
          () =>
            (
              panel.current?.querySelector(
                "[data-request]",
              ) as HTMLElement | null
            )?.focus() ?? panel.current?.focus(),
        );
      }),
    ];
    return () => stops.forEach((stop) => stop());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // As tall as what it shows: the desktop keeps it within the screen.
  useEffect(() => {
    const root = panel.current;
    const inner = content.current;
    if (!root || !inner) return;
    const observer = new ResizeObserver(() => {
      const chrome =
        root.offsetHeight - (inner.parentElement?.clientHeight ?? 0);
      void trayResize(Math.ceil(chrome + inner.scrollHeight)).catch(() => {});
    });
    observer.observe(inner);
    return () => observer.disconnect();
  }, []);

  function keys(event: React.KeyboardEvent) {
    const item = waiting[focused];
    const move = (by: number) => {
      event.preventDefault();
      const next = Math.max(0, Math.min(waiting.length - 1, focused + by));
      setFocus(next);
      (
        panel.current?.querySelectorAll("[data-request]")[next] as
          | HTMLElement
          | undefined
      )?.focus();
    };
    if ((event.target as HTMLElement).closest("input, textarea")) return;
    if (event.key === "Escape") void trayHide();
    else if (event.key === "ArrowDown") move(1);
    else if (event.key === "ArrowUp") move(-1);
    else if (
      item &&
      event.key === "Enter" &&
      item.approval.kind === "permission"
    ) {
      event.preventDefault();
      void answer(item, "once");
    } else if (
      item &&
      (event.key === "Backspace" || event.key === "Delete") &&
      item.approval.kind === "permission"
    ) {
      event.preventDefault();
      void answer(item, "deny");
    }
  }

  let shownWorkspace: string | undefined;
  return (
    <div
      ref={panel}
      tabIndex={-1}
      onKeyDown={keys}
      onFocus={(event) => {
        const at = [
          ...(panel.current?.querySelectorAll("[data-request]") ?? []),
        ].indexOf(
          (event.target as HTMLElement).closest("[data-request]") as Element,
        );
        if (at >= 0) setFocus(at);
      }}
      className="flex h-screen flex-col overflow-hidden rounded-[14px] border bg-popover text-popover-foreground outline-none"
    >
      <header className="flex shrink-0 items-center gap-2 border-b py-2 pr-2 pl-2.5">
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <button
                type="button"
                className="flex min-w-0 items-center gap-2 rounded-md px-1.5 py-1 text-[13.5px] font-semibold hover:bg-accent aria-expanded:bg-accent"
              />
            }
          >
            <Mark className={cn("size-4 shrink-0", !live && "opacity-50")} />
            <span className="truncate">{active?.name ?? "ZeroLux"}</span>
            <ChevronDownIcon
              aria-hidden
              className="size-3 shrink-0 text-faint"
            />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-56">
            {workspaces.map((workspace) => (
              <DropdownMenuItem
                key={workspace.profile}
                onClick={() => void trayOpen(workspace.profile)}
              >
                <span className="min-w-0 flex-1 truncate">
                  {workspace.name}
                </span>
                {workspace.active && <CheckIcon />}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
        <span className="ml-auto flex items-center gap-1.5 text-xs text-muted-foreground">
          <span
            className={cn(
              "size-1.5 rounded-full",
              live ? "bg-success" : "bg-faint",
            )}
          />
          {live ? "Live" : "Offline"}
        </span>
        {active && (
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Open ZeroLux"
            title="Open ZeroLux"
            onClick={() => void trayOpen(active.profile)}
          >
            <SquareArrowOutUpRightIcon />
          </Button>
        )}
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div ref={content} className="pb-1">
          <Label count={waiting.length}>Needs you</Label>
          {waiting.length === 0 ? (
            <p className="mx-2 mb-1.5 flex items-center gap-2 rounded-[10px] border border-dashed p-3 text-[12.5px] text-muted-foreground">
              <CheckIcon className="size-3.5 text-success" />
              Nothing needs you
            </p>
          ) : (
            waiting.map((item, at) => {
              const named =
                workspaces.length > 1 &&
                shownWorkspace !== item.workspace.profile;
              shownWorkspace = item.workspace.profile;
              return (
                <div key={`${item.workspace.profile}:${item.approval.id}`}>
                  {named && (
                    <p className="px-3.5 pb-1 text-[11.5px] text-faint">
                      {item.workspace.name}
                    </p>
                  )}
                  <TrayRequest
                    waiting={item}
                    focused={at === focused}
                    answer={(choice) => void answer(item, choice)}
                    open={() => open(item)}
                  />
                </div>
              );
            })
          )}
          {error && (
            <p className="mx-3.5 mb-1.5 text-xs text-destructive">{error}</p>
          )}
          {/* A workspace that cannot be heard says why, in its own line. */}
          {ordered.map(
            (workspace) =>
              heard[workspace.profile]?.error && (
                <p
                  key={workspace.profile}
                  className="mx-3.5 mb-1.5 text-xs text-destructive"
                >
                  {workspace.name}: {heard[workspace.profile]!.error}
                </p>
              ),
          )}
          {plans.length > 0 && (
            <>
              <Label>Subscriptions</Label>
              {plans.map(({ subscription, kernel }) => (
                <TrayPlan
                  key={subscription.id}
                  subscription={subscription}
                  kernel={kernel}
                  now={now}
                />
              ))}
            </>
          )}
          {active && <TrayRows key={active.kernel} kernel={active.kernel} />}
        </div>
      </div>
      <footer className="flex shrink-0 items-center gap-0.5 border-t px-2 py-1.5 text-[12.5px]">
        {active && (
          <>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => void trayOpen(active.profile)}
            >
              Open ZeroLux
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="text-muted-foreground"
              onClick={() => void trayNewWindow(active.profile)}
            >
              New Window
            </Button>
          </>
        )}
      </footer>
      {workspaces.map((workspace) => (
        <Hear
          key={workspace.profile}
          workspace={workspace}
          attempt={attempts[workspace.profile] ?? 0}
          heard={(profile, state) =>
            setHeard((all) => ({ ...all, [profile]: state }))
          }
        />
      ))}
    </div>
  );
}
