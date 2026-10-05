import { cn } from "cn";
import type { MemberTone } from "@zerolux/chat";

export type LampState = MemberTone;

const look: Record<LampState, string> = {
  on: "bg-human shadow-[0_0_6px_var(--color-human)]",
  working: "animate-pulse bg-agent shadow-[0_0_6px_var(--color-agent)]",
  connecting: "animate-pulse bg-faint",
  connected: "bg-agent/60",
  attention: "bg-attention",
  stopped: "ring-1 ring-faint ring-inset",
};

/** The small light beside a member: round for people, square for agents, like their marks. */
export function Lamp({
  kind,
  state,
  className,
}: {
  kind: "human" | "agent";
  state: LampState;
  className?: string;
}) {
  return (
    <span
      aria-hidden
      className={cn(
        "inline-block size-2 shrink-0",
        kind === "human" ? "rounded-full" : "rounded-[1.5px]",
        look[state],
        className,
      )}
    />
  );
}
