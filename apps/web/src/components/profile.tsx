import { cn } from "cn";
import { creationDateLabel, harnessLabels } from "@zerolux/chat";
import type { Actor } from "@zerolux/chat";
import { Lamp } from "@/components/lamp";
import type { LampState } from "@/components/lamp";
import { ActorMark } from "@/components/presence";

/** What a member is: a person, or an agent by its harness. */
export const memberRole = (actor: Actor) =>
  actor.kind === "human"
    ? "Person"
    : actor.harness
      ? harnessLabels[actor.harness]
      : "Agent";

/** A member's mark with its light in the corner. */
export function Mark({
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

/** The top of a member's profile: who they are, their state, and what can be done. */
export function ProfileHead({
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

/** Facts about a member, each label beside its value. */
export function Facts({ children }: { children: React.ReactNode }) {
  return (
    <dl className="grid grid-cols-[6rem_minmax(0,1fr)] items-baseline gap-x-3 gap-y-2 text-sm">
      {children}
    </dl>
  );
}

export function Fact({
  label,
  className,
  children,
}: {
  label: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <>
      <dt className="text-faint">{label}</dt>
      <dd className={cn("min-w-0", className)}>{children}</dd>
    </>
  );
}
