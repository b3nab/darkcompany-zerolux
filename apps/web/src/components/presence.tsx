import { cn } from "cn";
import type { Tone } from "@zerolux/chat";
import { Lamp } from "./lamp";

export type { Tone };

const text: Record<Tone, string> = {
  working: "text-agent-foreground",
  connecting: "text-muted-foreground",
  connected: "text-foreground",
  attention: "text-attention",
  stopped: "text-muted-foreground",
};

export function Presence({
  tone,
  children,
  className,
}: {
  tone: Tone;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <span
      data-tone={tone}
      className={cn(
        "inline-flex items-center gap-1.5 text-xs",
        text[tone],
        className,
      )}
    >
      <Lamp kind="agent" state={tone} className="size-1.5" />
      {children}
    </span>
  );
}

/** A person is round, an agent is square: the shape says who acted, not only the name. */
export function ActorMark({
  kind,
  name,
  className,
}: {
  kind: "human" | "agent";
  name: string;
  className?: string;
}) {
  return (
    <span
      aria-hidden
      className={cn(
        "inline-flex size-8 shrink-0 items-center justify-center border text-xs font-semibold",
        kind === "human"
          ? "rounded-full border-human/35 bg-human/10 text-human-foreground"
          : "rounded-[22%] border-agent/35 bg-agent/10 font-mono font-normal text-agent-foreground",
        className,
      )}
    >
      {kind === "human" ? name.slice(0, 1).toUpperCase() : name.slice(0, 2)}
    </span>
  );
}

/** The small uppercase label above a section or page. */
export function Eyebrow({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "font-mono text-[11px] font-medium tracking-[0.09em] text-faint uppercase",
        className,
      )}
    >
      {children}
    </span>
  );
}
