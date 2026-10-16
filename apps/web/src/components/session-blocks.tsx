import { useId, useState } from "react";
import type { ReactNode } from "react";
import { cn } from "cn";
import { ChevronRightIcon, CircleAlertIcon } from "lucide-react";
import {
  blockRuns,
  thoughtLabel,
  toolItems,
  turnLabel,
  useArrivals,
} from "@zerolux/chat";
import type { SessionBlock } from "@zerolux/chat";
import { MessageText } from "@/components/message-text";
import { ExploredCalls, ToolCall } from "@/components/tool-call";
import type { ChatTitle } from "@/components/tool-call";
import { Reveal } from "@/components/reveal";

const ARRIVE =
  "animate-in fade-in slide-in-from-bottom-1 duration-300 motion-reduce:animate-none";

/**
 * A session's work, block by block, the same in the Agent Console and in chats. Tools run
 * one after another read as one list; work that arrives live slides in.
 */
export function SessionBlocks({
  blocks,
  chatTitle,
}: {
  blocks: SessionBlock[];
  /** How a chat is named: inputs say which chat they came from, ZeroLux tools where they wrote. */
  chatTitle?: ChatTitle;
}) {
  const fresh = useArrivals(blocks);
  return blockRuns(blocks).map((run) =>
    run.kind === "tools" ? (
      <div
        key={run.key}
        className={cn(
          "divide-y overflow-hidden rounded-md border bg-card text-sm",
          fresh.has(run.key) && ARRIVE,
        )}
      >
        {toolItems(run.tools).map((item) => (
          <div key={item.key} className={cn(fresh.has(item.key) && ARRIVE)}>
            {item.kind === "explored" ? (
              <ExploredCalls tools={item.tools} chatTitle={chatTitle} />
            ) : (
              <ToolCall tool={item} chatTitle={chatTitle} />
            )}
          </div>
        ))}
      </div>
    ) : (
      <div
        key={run.key}
        className={cn("flex flex-col", fresh.has(run.key) && ARRIVE)}
      >
        <Block block={run} chatTitle={chatTitle} />
      </div>
    ),
  );
}

/** A line that opens on what it holds, sliding open and closed. */
function Fold({
  trigger,
  className,
  children,
}: {
  trigger: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const panel = useId();
  return (
    <div className={className}>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={panel}
        onClick={() => setOpen(!open)}
        className="group/fold flex w-full min-w-0 items-baseline gap-2 text-left outline-none"
      >
        <ChevronRightIcon
          aria-hidden
          className="size-3 shrink-0 translate-y-0.5 text-faint transition-transform group-aria-expanded/fold:rotate-90 motion-reduce:transition-none"
        />
        {trigger}
      </button>
      <Reveal open={open} id={panel}>
        {children}
      </Reveal>
    </div>
  );
}

function Block({
  block,
  chatTitle,
}: {
  block: SessionBlock;
  chatTitle?: ChatTitle;
}) {
  switch (block.kind) {
    case "input":
      return (
        <div className="max-w-[min(40rem,85%)] self-end rounded-md rounded-br-xs border border-human/25 bg-human/10 px-3.5 py-2">
          {block.chat && chatTitle && (
            <p className="mb-1 font-mono text-[11px] text-faint">
              From {chatTitle(block.chat) ?? "a chat"}
            </p>
          )}
          <p className="text-sm whitespace-pre-wrap break-words">
            {block.text}
          </p>
        </div>
      );
    case "text":
      return <MessageText text={block.text} />;
    case "thinking":
      return (
        <Fold
          className="text-sm text-muted-foreground"
          trigger={
            // Its first line says what the reasoning is about; opened, all of it.
            <>
              <span className="shrink-0 font-mono text-[12px] text-faint transition-colors group-hover/fold:text-muted-foreground">
                {thoughtLabel(block)}
              </span>
              <span className="min-w-0 truncate text-[12.5px] text-faint italic group-aria-expanded/fold:invisible">
                {block.text.trim().split("\n")[0]}
              </span>
            </>
          }
        >
          <p className="mt-1.5 ml-1.5 border-l pl-3.5 whitespace-pre-wrap">
            {block.text}
          </p>
        </Fold>
      );
    case "tool":
      return <ToolCall tool={block} chatTitle={chatTitle} />;
    case "turn":
      return (
        <p className="my-1 flex items-center gap-3 font-mono text-[11px] text-faint before:h-px before:flex-1 before:bg-border after:h-px after:flex-1 after:bg-border">
          {turnLabel(block)}
        </p>
      );
    case "error":
      return (
        <p className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          <CircleAlertIcon aria-hidden className="mt-0.5 size-3.5 shrink-0" />
          {block.message}
        </p>
      );
    case "compacted":
      return (
        <Fold
          className="text-sm"
          trigger={
            <span className="font-mono text-[11px] text-faint">
              Context compacted
            </span>
          }
        >
          {block.summary && (
            <p className="mt-1.5 ml-1.5 border-l pl-3.5 whitespace-pre-wrap text-muted-foreground">
              {block.summary}
            </p>
          )}
        </Fold>
      );
  }
}
