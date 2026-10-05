import { Link } from "react-router";
import { cn } from "cn";
import {
  ago,
  facade,
  greeting,
  memberTone,
  needsYou,
  runningNow,
  useMeetings,
} from "@zerolux/chat";
import type { Chat, MemberTone, Perform, Place } from "@zerolux/chat";
import { activeActors } from "./api";
import type { Actor, Workspace } from "./api";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import {
  Card,
  CardAction,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Meter } from "@/components/meter";
import { Page } from "@/components/page";
import { ActorMark, Eyebrow } from "@/components/presence";

/** The web address of something the home lists. */
const to = (place: Place) =>
  "chat" in place
    ? `/chats/${place.chat}`
    : "task" in place
      ? `/projects/${place.project}?task=${place.task}`
      : "/team";

/** The home: what waits for the owner, what runs now, who is in, how the projects stand. */
export function Tonight({
  workspace,
  chat,
  owner,
  busy,
  perform,
  capabilities,
}: {
  workspace: Workspace;
  chat: Chat;
  owner: Actor;
  busy: boolean;
  perform: Perform;
  capabilities: string[];
}) {
  const live = useMeetings(capabilities.includes("meetings-v1")).meetings;
  const actors = activeActors(workspace.actors);
  const actor = (id: string) => workspace.actors.find((a) => a.id === id);
  const needs = needsYou(workspace, chat);
  const running = runningNow(workspace, chat);
  const tones = actors.map((a) =>
    memberTone(a, owner.id, chat.sessions, workspace.connections),
  );
  const people = actors.filter((a) => a.kind === "human");
  const working = tones.filter((t) => t === "working").length;
  const peopleIn = tones.filter((t) => t === "on").length;
  const now = new Date();

  return (
    <Page>
      <header className="flex flex-col gap-2.5">
        <Eyebrow>
          {now.toLocaleDateString(undefined, {
            weekday: "long",
            day: "numeric",
            month: "long",
          })}{" "}
          ·{" "}
          {now.toLocaleTimeString(undefined, {
            hour: "2-digit",
            minute: "2-digit",
          })}
        </Eyebrow>
        <h1 className="text-4xl font-normal tracking-tight text-balance">
          {greeting(now.getHours())}, {owner.name}.{" "}
          <em className="text-human-foreground not-italic">
            {needs.length === 0
              ? "Nothing needs you."
              : `${needs.length} ${needs.length === 1 ? "thing needs" : "things need"} you.`}
          </em>
        </h1>
      </header>
      <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1.7fr)_minmax(17rem,1fr)]">
        <div className="flex min-w-0 flex-col gap-4">
          {live.map((meeting) => (
            <div
              key={meeting.id}
              className="flex items-center gap-3.5 rounded-md border border-human/30 bg-human/10 px-3.5 py-3"
            >
              <span className="flex -space-x-1.5">
                {meeting.participants.map((id) => (
                  <ActorMark
                    key={id}
                    kind={actor(id)?.kind ?? "agent"}
                    name={actor(id)?.name ?? "?"}
                    className="size-6.5 text-[10px] ring-2 ring-background"
                  />
                ))}
              </span>
              <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                <strong className="truncate text-sm font-semibold">
                  {meeting.title} is live
                </strong>
                <span className="truncate text-xs text-muted-foreground">
                  {meeting.participants
                    .map((id) => actor(id)?.name ?? "someone")
                    .join(", ")}{" "}
                  · started {ago(meeting.started_at)}
                </span>
              </div>
              <Link
                to={`/meetings?room=${meeting.id}`}
                className={buttonVariants({ size: "sm" })}
              >
                Join
              </Link>
            </div>
          ))}
          <Card className="gap-0 pb-0">
            <CardHeader className="border-b">
              <CardTitle>Needs you</CardTitle>
              <CardAction>
                <Badge className="bg-human/10 font-mono text-human-foreground">
                  {needs.length}
                </Badge>
              </CardAction>
            </CardHeader>
            <ul className="divide-y">
              {needs.length === 0 && (
                <li className="px-4 py-3.5 text-sm text-muted-foreground">
                  Nothing is waiting on you. Agents ask here when that changes.
                </li>
              )}
              {needs.map((need) => (
                <li
                  key={need.key}
                  className="flex items-center gap-3 px-4 py-3.5"
                >
                  <ActorMark
                    kind={actor(need.actorId)?.kind ?? "agent"}
                    name={actor(need.actorId)?.name ?? "?"}
                  />
                  <Link
                    to={to(need.place)}
                    className="flex min-w-0 flex-1 flex-col gap-1 hover:underline"
                  >
                    <span className="truncate text-xs text-faint">
                      {[need.kind, need.since && ago(need.since), need.where]
                        .filter(Boolean)
                        .join(" · ")}{" "}
                      · from{" "}
                      <span className="font-mono text-agent-foreground">
                        {actor(need.actorId)?.name ?? "unknown"}
                      </span>
                    </span>
                    <span className="text-sm font-medium text-pretty">
                      {need.title}
                    </span>
                  </Link>
                  {need.approvalId ? (
                    <div className="flex shrink-0 gap-1.5">
                      {(["deny", "allow"] as const).map((decision) => (
                        <Button
                          key={decision}
                          size="sm"
                          variant={decision === "deny" ? "outline" : "default"}
                          disabled={busy}
                          onClick={() =>
                            void perform(() =>
                              chat.decide(need.approvalId!, decision),
                            )
                          }
                        >
                          {decision === "deny" ? "Deny" : "Allow"}
                        </Button>
                      ))}
                    </div>
                  ) : (
                    <Link
                      to={to(need.place)}
                      className={buttonVariants({
                        variant: "outline",
                        size: "sm",
                      })}
                    >
                      Review
                    </Link>
                  )}
                </li>
              ))}
            </ul>
          </Card>
          <Card className="gap-0 pb-0">
            <CardHeader className="border-b">
              <CardTitle>Running now</CardTitle>
              <CardAction>
                <Badge className="bg-agent/10 font-mono text-agent-foreground">
                  {running.length} running
                </Badge>
              </CardAction>
            </CardHeader>
            <ul className="divide-y">
              {running.length === 0 && (
                <li className="px-4 py-3.5 text-sm text-muted-foreground">
                  No agent is working right now.
                </li>
              )}
              {running.map((run) => (
                <li key={run.key}>
                  <Link
                    to={to(run.place)}
                    className="grid grid-cols-[1.5rem_6rem_minmax(0,1fr)_auto] items-center gap-3 px-4 py-2.5 transition-colors hover:bg-accent"
                  >
                    <ActorMark
                      kind="agent"
                      name={actor(run.actorId)?.name ?? "?"}
                      className="size-6"
                    />
                    <span className="truncate font-mono text-sm text-agent-foreground">
                      {actor(run.actorId)?.name ?? "unknown"}
                    </span>
                    <span className="truncate text-sm">{run.what}</span>
                    <span className="font-mono text-xs text-faint">
                      {run.since ? ago(run.since) : "now"}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          </Card>
        </div>
        <div className="flex min-w-0 flex-col gap-4">
          <Card>
            <CardHeader>
              <Eyebrow>In the building</Eyebrow>
              <CardTitle>
                {peopleIn} of {people.length}{" "}
                {people.length === 1 ? "person" : "people"} in · {working}{" "}
                {working === 1 ? "agent" : "agents"} working
              </CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-3">
              <Facade tones={tones} />
              <ul className="flex flex-wrap gap-x-3.5 gap-y-1.5 text-xs text-muted-foreground">
                {legend.map(([label, window]) => (
                  <li key={label} className="flex items-center gap-1.5">
                    <span
                      aria-hidden
                      className={cn("size-2 rounded-xs", window)}
                    />
                    {label}
                  </li>
                ))}
              </ul>
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <Eyebrow>Projects</Eyebrow>
              <CardTitle>
                {workspace.projects.length}{" "}
                {workspace.projects.length === 1 ? "project" : "projects"}
              </CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-3.5">
              {workspace.projects.length === 0 && (
                <p className="text-sm text-muted-foreground">
                  No projects yet.
                </p>
              )}
              {workspace.projects.map((p) => {
                const tasks = workspace.tasks.filter(
                  (t) => t.project_id === p.id,
                );
                const done = tasks.filter((t) => t.status === "done").length;
                return (
                  <Link key={p.id} to={`/projects/${p.id}`}>
                    <Meter
                      label={p.name}
                      value={done}
                      max={tasks.length}
                      valueLabel={`${done} / ${tasks.length} done`}
                      tone="success"
                    />
                  </Link>
                );
              })}
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <Eyebrow>Agent spend</Eyebrow>
              <CardTitle>This month</CardTitle>
            </CardHeader>
            <CardContent>
              {/* TODO: kernel: each agent's monthly spend and budget, from its harness usage; one meter per owner here. */}
              <p className="text-sm text-muted-foreground">
                Spend and budgets are not tracked yet.
              </p>
            </CardContent>
          </Card>
        </div>
      </div>
    </Page>
  );
}

const windows: Record<MemberTone, string> = {
  on: "bg-human shadow-[0_0_10px_-1px_var(--color-human)]",
  working: "animate-pulse bg-agent shadow-[0_0_9px_-2px_var(--color-agent)]",
  connected: "bg-window-dim",
  connecting: "bg-window-dim",
  attention: "bg-destructive",
  stopped: "bg-window-off",
};
const legend = [
  ["person in", windows.on],
  ["agent working", windows.working],
  ["idle", windows.connected],
  ["needs attention", windows.attention],
  ["empty seat", "bg-window-off ring-1 ring-border ring-inset"],
] as const;

/** The company as a building at night: one lit window per person in or agent at work. */
function Facade({ tones }: { tones: MemberTone[] }) {
  return (
    <div
      role="img"
      aria-label="Who is in"
      className="grid grid-cols-8 gap-1.5 rounded-sm border bg-background p-3.5"
    >
      {facade(tones).map((tone, i) => (
        <span
          key={i}
          className={cn("aspect-[3/4] rounded-xs", windows[tone])}
        />
      ))}
    </div>
  );
}
