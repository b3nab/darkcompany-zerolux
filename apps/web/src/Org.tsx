import { useState } from "react";
import { Link, useSearchParams } from "react-router";
import { cn } from "cn";
import {
  agentWork,
  creationDateLabel,
  memberTone,
  shiftLabels,
  shiftSegments,
  shiftWindow,
} from "@zerolux/chat";
import type { Chat, ShiftSegment } from "@zerolux/chat";
import { activeActors, harnessLabels } from "./api";
import type { Actor, Workspace } from "./api";
import { agentPresence } from "./presence";
import { buttonVariants } from "@/components/ui/button";
import { Lamp } from "@/components/lamp";
import type { LampState } from "@/components/lamp";
import { ActorMark, Eyebrow } from "@/components/presence";
import { SidePanel } from "@/components/side-panel";
import { LG, useMedia } from "./media";

type View = "everyone" | "people" | "agents" | "shift";
const views: Record<View, { label: string; note: string }> = {
  everyone: {
    label: "Everyone",
    note: "People report to people. Each person's agents hang off them.",
  },
  people: { label: "People", note: "Who reports to whom." },
  agents: {
    label: "Agents",
    note: "The agent org mirrors the people org: an agent sits where its owner sits.",
  },
  shift: { label: "Shift", note: "Who worked when, over the last 16 hours." },
};

/**
 * The organization chart: people, and under each of them the agents they own. Agents follow
 * their owners' hierarchy; they have none of their own.
 */
export function Organization({
  workspace,
  chat,
}: {
  workspace: Workspace;
  chat: Chat;
}) {
  const [view, setView] = useState<View>("everyone");
  // The address names the open profile, so other pages can link to it.
  const [params, setParams] = useSearchParams();
  const actors = activeActors(workspace.actors);
  // TODO: kernel: people report to people; the chart nests them then. Today each person heads a tree.
  const people = actors.filter((a) => a.kind === "human");
  const owner = people[0];
  const agentsOf = (person: Actor) =>
    actors.filter((a) => a.owner_id === person.id);
  const state = (actor: Actor) =>
    memberTone(actor, owner?.id, chat.sessions, workspace.connections);
  const selected =
    actors.find((a) => a.id === params.get("actor")) ?? owner ?? actors[0];
  const select = (actor: Actor) =>
    setParams({ actor: actor.id }, { replace: true });
  const wide = useMedia(LG);
  const node = (actor: Actor, agents: Actor[] = []) => (
    <Node
      actor={actor}
      state={state}
      agents={agents}
      selected={actor.id === selected?.id}
      select={select}
    />
  );

  const profile = selected && (
    <aside
      aria-label={`${selected.name}'s profile`}
      className="flex min-h-0 flex-1 flex-col border-t bg-card lg:overflow-y-auto lg:border-t-0"
    >
      {selected.kind === "human" ? (
        <PersonProfile
          person={selected}
          isOwner={selected.id === owner?.id}
          agents={agentsOf(selected)}
          state={state}
          presence={(a) =>
            agentPresence(a.id, chat.sessions, workspace.connections).label
          }
          select={select}
        />
      ) : (
        <AgentProfile
          key={selected.id}
          agent={selected}
          owner={actors.find((a) => a.id === selected.owner_id)}
          workspace={workspace}
          chat={chat}
          state={state(selected)}
          select={select}
        />
      )}
    </aside>
  );

  return (
    <SidePanel
      id="org"
      wide={wide}
      panel={profile}
      size={360}
      min={280}
      max={560}
      className="grid min-h-0 flex-1 overflow-y-auto"
    >
      <section
        aria-label="Organization"
        className="min-h-0 min-w-0 flex-1 overflow-auto bg-background bg-[radial-gradient(var(--color-border)_1px,transparent_1px)] bg-size-[18px_18px] px-4 pt-6 pb-12 md:px-8"
      >
        <div className="mb-7 flex flex-wrap items-center gap-x-3.5 gap-y-2.5">
          <div
            role="group"
            aria-label="View"
            className="flex rounded-lg border bg-card p-0.5"
          >
            {(Object.keys(views) as View[]).map((id) => (
              <button
                key={id}
                type="button"
                aria-pressed={view === id}
                onClick={() => setView(id)}
                className="h-7 rounded-md px-3 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground aria-pressed:bg-accent aria-pressed:text-foreground"
              >
                {views[id].label}
              </button>
            ))}
          </div>
          <Link
            to="/team/hire"
            className={cn(
              buttonVariants({ variant: "outline", size: "sm" }),
              "border-agent/30 bg-agent/10 text-agent-foreground hover:bg-agent/20 hover:text-agent-foreground",
            )}
          >
            Hire agent
          </Link>
          <p className="max-w-md flex-[1_1_16rem] text-xs text-faint">
            {views[view].note}
          </p>
        </div>
        {view === "shift" ? (
          <Shift
            people={people}
            agentsOf={agentsOf}
            selected={selected}
            select={select}
          />
        ) : (
          <ul className="flex min-w-max justify-center gap-5">
            {people.map((person) => (
              <li key={person.id} className="w-56">
                {view === "agents" ? (
                  <div className="flex flex-col gap-1.5">
                    <span className="mb-0.5 flex items-center gap-1.5 text-xs text-faint">
                      <ActorMark
                        kind="human"
                        name={person.name}
                        className="size-4 text-[8px]"
                      />
                      {person.name}'s agents
                    </span>
                    {agentsOf(person).map((agent) => (
                      <div key={agent.id}>{node(agent)}</div>
                    ))}
                    {agentsOf(person).length === 0 && (
                      <p className="text-xs text-faint">No agents yet.</p>
                    )}
                  </div>
                ) : (
                  node(person, view === "everyone" ? agentsOf(person) : [])
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
    </SidePanel>
  );
}

/** One member of the chart; a person's card lists their agents underneath. */
function Node({
  actor,
  state,
  agents,
  selected,
  select,
}: {
  actor: Actor;
  state: (actor: Actor) => LampState;
  agents: Actor[];
  selected: boolean;
  select: (actor: Actor) => void;
}) {
  const human = actor.kind === "human";
  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={() => select(actor)}
      className={cn(
        "flex w-full min-w-0 flex-col gap-2.5 border p-3 text-left transition-colors hover:border-faint",
        human
          ? "rounded-lg bg-card"
          : "rounded-xs border-dashed bg-secondary p-2.5",
        selected &&
          (human
            ? "border-human/40 ring-1 ring-human/30"
            : "border-solid border-agent/40 ring-1 ring-agent/30"),
      )}
    >
      <span className="flex min-w-0 items-center gap-2.5">
        <Mark actor={actor} state={state(actor)} />
        <span className="flex min-w-0 flex-col gap-0.5">
          <span
            className={cn(
              "truncate text-sm font-semibold",
              !human && "font-mono font-medium text-agent-foreground",
            )}
          >
            {actor.name}
          </span>
          <span className="truncate text-xs text-faint">{role(actor)}</span>
        </span>
      </span>
      {agents.length > 0 && (
        <span className="flex items-center gap-2 border-t border-dashed pt-2">
          <span className="flex gap-1">
            {agents.slice(0, 5).map((agent) => (
              <Mark
                key={agent.id}
                actor={agent}
                state={state(agent)}
                className="size-4.5 text-[8px]"
              />
            ))}
          </span>
          <span className="font-mono text-xs whitespace-nowrap text-agent-foreground">
            {agents.length} agent{agents.length === 1 ? "" : "s"}
          </span>
        </span>
      )}
    </button>
  );
}

const role = (actor: Actor) =>
  actor.kind === "human"
    ? "Person"
    : actor.harness
      ? harnessLabels[actor.harness]
      : "Agent";

/** A member's mark with its light in the corner. */
function Mark({
  actor,
  state,
  className,
}: {
  actor: Actor;
  state: LampState;
  className?: string;
}) {
  return (
    <span className="relative shrink-0">
      <ActorMark kind={actor.kind} name={actor.name} className={className} />
      <Lamp
        kind={actor.kind}
        state={state}
        className="absolute -right-0.5 -bottom-0.5 size-1.5 outline-2 outline-card"
      />
    </span>
  );
}

function PersonProfile({
  person,
  isOwner,
  agents,
  state,
  presence,
  select,
}: {
  person: Actor;
  isOwner: boolean;
  agents: Actor[];
  state: (actor: Actor) => LampState;
  presence: (agent: Actor) => string;
  select: (actor: Actor) => void;
}) {
  const first = person.name.split(" ")[0];
  return (
    <>
      <ProfileHead
        actor={person}
        state={state(person)}
        role={isOwner ? "Owner" : "Person"}
        status={state(person) === "on" ? "Online" : "Offline"}
      />
      <section className="flex flex-col gap-2.5 border-b px-5 py-4">
        <dl className="grid grid-cols-[6rem_minmax(0,1fr)] items-center gap-x-3 gap-y-2 text-sm">
          <dt className="text-faint">Reports to</dt>
          <dd className="text-faint">No one</dd>
          <dt className="text-faint">Agents</dt>
          <dd className="font-mono">{agents.length}</dd>
        </dl>
      </section>
      <section className="flex flex-col gap-1 px-5 py-4">
        <Eyebrow className="mb-1.5">Agents · {agents.length}</Eyebrow>
        {agents.map((agent) => (
          <button
            key={agent.id}
            type="button"
            onClick={() => select(agent)}
            className="-mx-2 flex items-center gap-2.5 rounded-sm px-2 py-1.5 text-left transition-colors hover:bg-accent"
          >
            <Mark actor={agent} state={state(agent)} className="size-6" />
            <span className="truncate font-mono text-sm text-agent-foreground">
              {agent.name}
            </span>
            <span className="ml-auto truncate text-xs text-faint">
              {presence(agent)}
            </span>
          </button>
        ))}
        {agents.length === 0 && (
          <p className="text-sm text-muted-foreground">No agents yet.</p>
        )}
        {/* TODO: kernel: each agent's monthly spend against its budget, one meter per agent here. */}
        <p className="mt-2 text-xs text-pretty text-muted-foreground">
          {first}'s agents sit where {first} sits in the organization.
        </p>
      </section>
    </>
  );
}

function AgentProfile({
  agent,
  owner,
  workspace,
  chat,
  state,
  select,
}: {
  agent: Actor;
  owner?: Actor;
  workspace: Workspace;
  chat: Chat;
  state: LampState;
  select: (actor: Actor) => void;
}) {
  const { label } = agentPresence(
    agent.id,
    chat.sessions,
    workspace.connections,
  );
  const { sessions, answering, task, dm, waiting } = agentWork(
    agent,
    workspace,
    chat,
  );
  return (
    <>
      <ProfileHead
        actor={agent}
        state={state}
        role={role(agent)}
        status={label}
      >
        {dm && (
          <Link
            to={`/chats/${dm.id}`}
            className={cn(
              buttonVariants({ size: "sm" }),
              "bg-agent text-background hover:bg-agent/80",
            )}
          >
            Message {agent.name}
          </Link>
        )}
        <Link
          to="/team"
          className={buttonVariants({ variant: "outline", size: "sm" })}
        >
          Sessions
        </Link>
      </ProfileHead>
      <section className="flex flex-col gap-3 border-b px-5 py-4">
        <dl className="grid grid-cols-[6rem_minmax(0,1fr)] items-center gap-x-3 gap-y-2 text-sm">
          <dt className="text-faint">Owned by</dt>
          <dd>
            {owner ? (
              <button
                type="button"
                onClick={() => select(owner)}
                className="flex items-center gap-1.5 font-medium text-human-foreground hover:underline"
              >
                <ActorMark
                  kind="human"
                  name={owner.name}
                  className="size-5 text-[9px]"
                />
                {owner.name}
              </button>
            ) : (
              <span className="text-faint">No one</span>
            )}
          </dd>
          <dt className="text-faint">Working on</dt>
          <dd className="min-w-0 truncate">
            {answering ? (
              <Link to={`/chats/${answering.id}`} className="hover:underline">
                Answering in {answering.title}
              </Link>
            ) : task ? (
              <Link
                to={`/projects/${task.project_id}?task=${task.id}`}
                className="hover:underline"
              >
                <span className="font-mono text-xs text-faint">
                  {task.id.slice(0, 8)}
                </span>{" "}
                {task.title}
              </Link>
            ) : (
              <span className="text-faint">Nothing right now</span>
            )}
          </dd>
          <dt className="text-faint">Runtime</dt>
          <dd className="font-mono text-xs">
            {agent.harness ?? "custom"} · {sessions.length} live session
            {sessions.length === 1 ? "" : "s"}
          </dd>
          <dt className="text-faint">Waiting</dt>
          <dd className="font-mono text-xs">
            {waiting} message{waiting === 1 ? "" : "s"}
          </dd>
        </dl>
      </section>
      <section className="flex flex-col gap-2 px-5 py-4">
        <Eyebrow>Budget</Eyebrow>
        {/* TODO: kernel: the agent's monthly spend and budget, from its harness usage. */}
        <p className="text-sm text-muted-foreground">Not tracked yet.</p>
      </section>
    </>
  );
}

function ProfileHead({
  actor,
  state,
  role,
  status,
  children,
}: {
  actor: Actor;
  state: LampState;
  role: string;
  status: string;
  children?: React.ReactNode;
}) {
  const human = actor.kind === "human";
  return (
    <header className="flex flex-col items-start gap-3 border-b px-5 pt-5.5 pb-4.5">
      <Mark actor={actor} state={state} className="size-14 text-lg" />
      <div className="flex flex-col gap-1">
        <h2
          className={cn(
            "text-xl font-medium tracking-tight",
            !human && "font-mono text-agent-foreground",
          )}
        >
          {actor.name}
        </h2>
        <p className="text-sm text-muted-foreground">{role}</p>
        <p className="text-xs text-faint">{creationDateLabel(actor)}</p>
      </div>
      <span className="flex items-center gap-2 text-xs text-muted-foreground">
        <Lamp kind={actor.kind} state={state} />
        {status}
      </span>
      {children && <div className="flex flex-wrap gap-1.5">{children}</div>}
    </header>
  );
}

const segmentLook: Record<ShiftSegment["kind"], string> = {
  working: "h-2 rounded-sm bg-agent",
  waiting:
    "h-2 rounded-sm bg-attention bg-[repeating-linear-gradient(135deg,transparent_0_3px,var(--color-background)_3px_4px)]",
  online: "h-1 rounded-full bg-faint",
};
// Work and waits fill the lane; being online is a thin line through its middle.
const segmentLane: Record<ShiftSegment["kind"], string> = {
  working: "top-4.5 h-5",
  waiting: "top-4.5 h-5",
  online: "top-6.5",
};

/** Lanes over the last 16 hours: when each person was online and each agent worked or waited. */
function Shift({
  people,
  agentsOf,
  selected,
  select,
}: {
  people: Actor[];
  agentsOf: (person: Actor) => Actor[];
  selected?: Actor;
  select: (actor: Actor) => void;
}) {
  const shift = shiftWindow();
  const at = (time: number) => `${shift.at(time) * 100}%`;
  const time = (t: number) =>
    new Date(t).toLocaleTimeString(undefined, {
      hour: "2-digit",
      minute: "2-digit",
    });
  const rows = people.flatMap((person) => [person, ...agentsOf(person)]);
  return (
    <div className="flex flex-col gap-5">
      <section
        aria-label={`Shift from ${time(shift.start)} to ${time(shift.end)}`}
        className="relative overflow-hidden rounded-lg border bg-card"
      >
        <div className="grid grid-cols-[14rem_minmax(0,1fr)] border-b">
          <Eyebrow className="px-4 py-3">
            {time(shift.start)} → {time(shift.end)}
          </Eyebrow>
          <div className="grid grid-cols-8 py-3">
            {shift.ticks.map((tick) => (
              <span
                key={tick}
                className="border-l pl-1.5 font-mono text-[11px] text-faint"
              >
                {time(tick)}
              </span>
            ))}
          </div>
        </div>
        {rows.map((actor) => (
          <div
            key={actor.id}
            className="grid grid-cols-[14rem_minmax(0,1fr)] items-center border-t first:border-t-0"
          >
            <button
              type="button"
              aria-pressed={actor.id === selected?.id}
              onClick={() => select(actor)}
              className={cn(
                "flex min-w-0 items-center gap-2.5 py-2 pr-3 text-left aria-pressed:bg-accent",
                actor.kind === "human" ? "pl-4" : "pl-8",
              )}
            >
              <ActorMark
                kind={actor.kind}
                name={actor.name}
                className="size-7"
              />
              <span className="flex min-w-0 flex-col">
                <span
                  className={cn(
                    "truncate text-sm font-semibold",
                    actor.kind === "agent" &&
                      "font-mono font-medium text-agent-foreground",
                  )}
                >
                  {actor.name}
                </span>
                <span className="truncate text-xs text-faint">
                  {role(actor)}
                </span>
              </span>
            </button>
            <div className="relative h-14">
              {/* The hour lines, on the same grid as the ticks above. */}
              <div aria-hidden className="absolute inset-0 grid grid-cols-8">
                {Array.from({ length: 8 }, (_, i) => (
                  <span key={i} className="border-l" />
                ))}
              </div>
              {shiftSegments(actor.id).map((s) => (
                <span
                  key={`${s.kind}:${s.from}`}
                  title={`${shiftLabels[s.kind]} ${time(s.from)}–${time(s.to)}`}
                  className={cn(
                    "absolute min-w-1",
                    segmentLook[s.kind],
                    segmentLane[s.kind],
                  )}
                  style={{
                    left: at(s.from),
                    width: `calc(${at(s.to)} - ${at(s.from)})`,
                  }}
                />
              ))}
            </div>
          </div>
        ))}
        <div
          aria-hidden
          className="pointer-events-none absolute top-10 bottom-0 border-l-[1.5px] border-foreground"
          style={{
            left: `calc(14rem + (100% - 14rem) * ${shift.at(shift.now)})`,
          }}
        >
          <span className="absolute -top-0.5 -translate-x-1/2 rounded-sm bg-foreground px-1.5 font-mono text-[10px] font-medium text-background">
            {time(shift.now)}
          </span>
        </div>
      </section>
      <ul className="flex flex-wrap gap-5 text-sm text-muted-foreground">
        {(Object.keys(segmentLook) as ShiftSegment["kind"][]).map((kind) => (
          <li key={kind} className="flex items-center gap-2">
            <span aria-hidden className={cn("w-5.5", segmentLook[kind])} />
            {shiftLabels[kind]}
          </li>
        ))}
      </ul>
    </div>
  );
}
