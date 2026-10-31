import { useMemo } from "react";
import { ChevronRightIcon } from "lucide-react";
import { currentStep, sessionBlocks, turnLine } from "@zerolux/chat";
import type { ChatTurn, RecordOf } from "@zerolux/chat";
import { SessionBlocks } from "@/components/session-blocks";
import type { ChatTitle } from "@/components/tool-call";

/** A turn's blocks as a chat shows them: its end is already in the line above. */
const workBlocks = (turn: ChatTurn | undefined) =>
  sessionBlocks(turn?.events ?? []).filter((b) => b.kind !== "turn");

/** What the agent did, under the message that asked: one line, open for the whole turn. */
export function WorkLine({
  name,
  turn,
  record,
  open,
  toggle,
  chatTitle,
}: {
  name: string;
  turn: ChatTurn;
  /** The session it is read from. */
  record?: RecordOf;
  open: boolean;
  toggle: () => void;
  chatTitle?: ChatTitle;
}) {
  const all = useMemo(() => sessionBlocks(turn.events), [turn]);
  const blocks = all.filter((b) => b.kind !== "turn");
  return (
    <li className="mt-1 ml-11 flex min-w-0 flex-col">
      <button
        type="button"
        aria-expanded={open}
        onClick={toggle}
        className="group -mx-1.5 flex w-fit max-w-full items-center gap-1.5 rounded-sm px-1.5 py-0.5 text-left font-mono text-[11.5px] text-faint transition-colors hover:bg-accent hover:text-muted-foreground"
      >
        <ChevronRightIcon
          aria-hidden
          className="size-3 shrink-0 transition-transform group-aria-expanded:rotate-90 motion-reduce:transition-none"
        />
        <span className="truncate">
          <span className="text-agent-foreground">{name}</span>{" "}
          {turnLine(turn, all)}
        </span>
      </button>
      {open && (
        <WorkBlocks blocks={blocks} record={record} chatTitle={chatTitle} />
      )}
    </li>
  );
}

/** An agent at work on this chat: its step now, open for the turn so far. */
export function LiveWork({
  name,
  turn,
  record,
  open,
  toggle,
  busy,
  interrupt,
  chatTitle,
}: {
  name: string;
  /** Absent until its turn is read. */
  turn?: ChatTurn;
  /** The session it is read from. */
  record?: RecordOf;
  open: boolean;
  toggle: () => void;
  busy: boolean;
  /** The owner's alone: absent for anyone else. */
  interrupt?: () => void;
  chatTitle?: ChatTitle;
}) {
  const blocks = useMemo(() => workBlocks(turn), [turn]);
  const step = currentStep(blocks);
  return (
    <div className="flex min-w-0 flex-col">
      <div className="flex max-w-full items-center gap-1 self-start rounded-full border border-agent/30 bg-agent/10 py-0.5 pr-1 pl-1 font-mono text-[11.5px] text-agent-foreground">
        <button
          type="button"
          aria-expanded={open}
          disabled={!turn}
          onClick={toggle}
          title={turn ? (open ? "Hide the work" : "Show the work") : undefined}
          className="group flex min-w-0 items-center gap-2 rounded-full py-1 pr-1.5 pl-2 transition-colors enabled:hover:bg-agent/10"
        >
          <span aria-hidden className="flex shrink-0 gap-1">
            {[0, 300, 600].map((delay) => (
              <span
                key={delay}
                style={{ animationDelay: `${delay}ms` }}
                className="size-1.5 animate-pulse rounded-[1.5px] bg-agent motion-reduce:animate-none"
              />
            ))}
          </span>
          <span className="truncate">
            {name}
            <span className="text-agent-foreground/70">
              {step ? ` · ${step}` : " is working"}
            </span>
          </span>
          {turn && (
            <ChevronRightIcon
              aria-hidden
              className="size-3 shrink-0 transition-transform group-aria-expanded:rotate-90 motion-reduce:transition-none"
            />
          )}
        </button>
        {interrupt && (
          <button
            type="button"
            disabled={busy}
            title={`Interrupt ${name}`}
            onClick={interrupt}
            className="shrink-0 rounded-full px-2 py-1 underline-offset-4 hover:underline disabled:opacity-50"
          >
            Interrupt
          </button>
        )}
      </div>
      {open && blocks.length > 0 && (
        <WorkBlocks blocks={blocks} record={record} chatTitle={chatTitle} />
      )}
    </div>
  );
}

function WorkBlocks({
  blocks,
  record,
  chatTitle,
}: {
  blocks: ReturnType<typeof workBlocks>;
  record?: RecordOf;
  chatTitle?: ChatTitle;
}) {
  return (
    <div className="mt-2 mb-1 ml-1.5 flex flex-col gap-2 border-l pl-4">
      <SessionBlocks blocks={blocks} record={record} chatTitle={chatTitle} />
    </div>
  );
}
