import { useState } from "react";
import { Link, useSearchParams } from "react-router";
import { cn } from "cn";
import {
  memberTone,
  shiftLabels,
  shiftSegments,
  shiftWindow,
} from "@zerolux/chat";
import type { Chat, Perform, ShiftSegment } from "@zerolux/chat";
import { activeActors } from "./api";
import type { Actor, Workspace } from "./api";
import { agentPresence } from "./presence";
import { AgentProfile } from "./Team";
import { Button, buttonVariants } from "@/components/ui/button";
import type { LampState } from "@/components/lamp";
import { ActorMark, Eyebrow } from "@/components/presence";
import {
  Fact,
  Facts,
  Mark,
  memberRole,
  ProfileHead,
} from "@/components/profile";
import { SidePanel } from "@/components/side-panel";
import { LG, useMedia } from "./media";
import { useMe } from "./AuthGate";
import { InvitePeople } from "./Invite";

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
  busy,
  perform,
}: {
  workspace: Workspace;
  chat: Chat;
  busy: boolean;
  perform: Perform;
}) {
  const [view, setView] = useState<View>("everyone");
  // The address names the open profile, so other pages can link to it.
  const [params, setParams] = useSearchParams();
  const actors = activeActors(workspace.actors);
  // TODO: kernel: people report to people; the chart nests them then. Today each person heads a tree.
  const people = actors.filter((a) => a.kind === "human");
  // The workspace's owner set it up; everyone else joined by invitation.
  const owner = people.find((a) => !a.invited_by) ?? people[0];
  const { owner: owns } = useMe(actors);
  const [inviting, setInviting] = useState(false);
  const agentsOf = (person: Actor) =>
    actors.filter((a) => a.owner_id === person.id);
  const state = (actor: Actor) => memberTone(actor, owner?.id, chat.sessions);
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
          presence={(a) => agentPresence(a.id, chat.sessions).label}
          select={select}
        />
      ) : (
        <AgentProfile
          key={selected.id}
          agent={selected}
          workspace={workspace}
          chat={chat}
          busy={busy}
          perform={perform}
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
          {owns && (
            <>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setInviting(true)}
              >
                Invite people
              </Button>
              <Link
                to="/team/hire"
                className={cn(
                  buttonVariants({ variant: "outline", size: "sm" }),
                  "border-agent/30 bg-agent/10 text-agent-foreground hover:bg-agent/20 hover:text-agent-foreground",
                )}
              >
                Hire agent
              </Link>
              <InvitePeople
                open={inviting}
                close={() => setInviting(false)}
                busy={busy}
                perform={perform}
              />
            </>
          )}
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
          <span className="truncate text-xs text-faint">
            {memberRole(actor)}
          </span>
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
        <Facts>
          <Fact label="Reports to" className="text-faint">
            No one
          </Fact>
          <Fact label="Agents" className="font-mono">
            {agents.length}
          </Fact>
        </Facts>
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
                  {memberRole(actor)}
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
