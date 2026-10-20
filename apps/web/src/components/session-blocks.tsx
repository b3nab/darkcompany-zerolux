import { useId } from "react";
import type { ReactNode } from "react";
import { cn } from "cn";
import { ChevronRightIcon, CircleAlertIcon } from "lucide-react";
import {
  blockRuns,
  isSubagent,
  thoughtLabel,
  toolItems,
  toolsPhrase,
  turnLabel,
  useArrivals,
} from "@zerolux/chat";
import type {
  Approval,
  ApprovalItem,
  LiveItem,
  SessionBlock,
  ToolsRun,
} from "@zerolux/chat";
import { MessageText } from "@/components/message-text";
import { ExploredCalls, SubagentCard, ToolCall } from "@/components/tool-call";
import type { ChatTitle } from "@/components/tool-call";
import { Reveal } from "@/components/reveal";
import { useDensity, useOpen } from "@/components/density";

const ARRIVE =
  "animate-in fade-in slide-in-from-bottom-1 duration-300 motion-reduce:animate-none";

/**
 * A session's work, block by block, the same in the Agent Console and in chats. Tools run
 * one after another read as one list; work that arrives live slides in. How much shows
 * follows the density around it: compact keeps the outcome, detailed opens every step.
 */
export function SessionBlocks({
  blocks,
  chatTitle,
  renderApproval,
  inputActions,
  textActions,
  openSubagent,
}: {
  blocks: (SessionBlock | ApprovalItem)[];
  /** How a chat is named: inputs say which chat they came from, ZeroLux tools where they wrote. */
  chatTitle?: ChatTitle;
  /** A request of the session, drawn where it was made: open while pending, a receipt after. */
  renderApproval?: (approval: Approval) => ReactNode;
  /** What the owner can do from one of the session's inputs, under it. */
  inputActions?: (input: InputBlock) => ReactNode;
  /** What can be done with the agent's words, under them: hearing them in its voice. */
  textActions?: (text: TextBlock) => ReactNode;
  /** Opens the work of the subagent a tool call started, where there is one to open. */
  openSubagent?: (toolCallId: string) => (() => void) | undefined;
}) {
  const fresh = useArrivals(blocks);
  const density = useDensity();
  return blockRuns(blocks).map((run) => {
    if (density === "compact" && run.kind === "thinking") return null;
    return (
      <div
        key={run.key}
        // Where in the record it comes from, for a link to that point.
        data-at={run.key.split(".")[0]}
        className={cn("flex flex-col", fresh.has(run.key) && ARRIVE)}
      >
        {run.kind === "tools" ? (
          <ToolRun run={run} fresh={fresh} chatTitle={chatTitle} />
        ) : run.kind === "approval" ? (
          renderApproval?.(run.approval)
        ) : (
          <Block
            block={run}
            chatTitle={chatTitle}
            inputActions={inputActions}
            textActions={textActions}
            openSubagent={openSubagent}
          />
        )}
      </div>
    );
  });
}

/** Tools run one after another: one card, or in compact density one line that opens on it. */
function ToolRun({
  run,
  fresh,
  chatTitle,
}: {
  run: ToolsRun;
  fresh: Set<string>;
  chatTitle?: ChatTitle;
}) {
  const card = (
    <div className="divide-y overflow-hidden rounded-md border bg-card text-sm">
      {toolItems(run.tools).map((item) => (
        <div
          key={item.key}
          data-at={item.key.split(".")[0]}
          className={cn(fresh.has(item.key) && ARRIVE)}
        >
          {item.kind === "explored" ? (
            <ExploredCalls tools={item.tools} chatTitle={chatTitle} />
          ) : (
            <ToolCall tool={item} chatTitle={chatTitle} />
          )}
        </div>
      ))}
    </div>
  );
  if (useDensity() !== "compact") return card;
  const running = run.tools.some((tool) => !tool.result && !tool.stopped);
  return (
    <Fold
      trigger={
        <span
          className={cn(
            "min-w-0 truncate font-mono text-[12px] text-faint transition-colors group-hover/fold:text-muted-foreground",
            running && "sweep",
          )}
        >
          {toolsPhrase(run.tools)}
        </span>
      }
    >
      <div className="mt-1.5">{card}</div>
    </Fold>
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
  const [open, setOpen] = useOpen();
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

/** An input of the session's: the owner's words, or a chat's message it was given. */
export type InputBlock = Extract<SessionBlock, { kind: "input" }>;
/** The agent's own words in the session. */
export type TextBlock = Extract<SessionBlock, { kind: "text" }>;

/** Words given to the session, with what goes under them. */
export function InputBubble({
  text,
  from,
  children,
}: {
  text: string;
  /** The chat they came from. */
  from?: string | null | false;
  children?: ReactNode;
}) {
  return (
    <div className="group/input flex flex-col items-end gap-1">
      <div className="max-w-[min(40rem,85%)] rounded-md rounded-br-xs border border-human/25 bg-human/10 px-3.5 py-2">
        {from && (
          <p className="mb-1 font-mono text-[11px] text-faint">From {from}</p>
        )}
        <p className="text-sm whitespace-pre-wrap break-words">{text}</p>
      </div>
      {children}
    </div>
  );
}

function Block({
  block,
  chatTitle,
  inputActions,
  textActions,
  openSubagent,
}: {
  block: SessionBlock;
  chatTitle?: ChatTitle;
  inputActions?: (input: InputBlock) => ReactNode;
  textActions?: (text: TextBlock) => ReactNode;
  openSubagent?: (toolCallId: string) => (() => void) | undefined;
}) {
  switch (block.kind) {
    case "input":
      return (
        <InputBubble
          text={block.text}
          from={block.chat && chatTitle && (chatTitle(block.chat) ?? "a chat")}
        >
          {inputActions?.(block)}
        </InputBubble>
      );
    case "text":
      return (
        <>
          <MessageText text={block.text} />
          {textActions?.(block)}
        </>
      );
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
      return isSubagent(block) ? (
        <SubagentCard
          tool={block}
          chatTitle={chatTitle}
          openWork={openSubagent?.(block.id)}
        />
      ) : (
        <ToolCall tool={block} chatTitle={chatTitle} />
      );
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

/** A running command's output in the stream: its last lines, as a terminal shows them. */
const LIVE_LINES = 40;

/**
 * What the session is producing right now, after its recorded work: the agent's words as they
 * come, its reasoning, a command's output. Each gives way to its block once recorded.
 */
export function LiveItems({ items }: { items: LiveItem[] }) {
  const density = useDensity();
  return items.map((item) =>
    item.kind === "text" ? (
      <div key={item.id} className={cn("flex flex-col", ARRIVE)}>
        <MessageText text={item.text} />
      </div>
    ) : item.kind === "thinking" ? (
      density !== "compact" && (
        <div key={item.id} className={cn("flex flex-col gap-1", ARRIVE)}>
          <span className="sweep font-mono text-[12px] text-faint">
            Thinking
          </span>
          <p className="ml-1.5 border-l pl-3.5 text-sm whitespace-pre-wrap text-muted-foreground italic">
            {item.text}
          </p>
        </div>
      )
    ) : (
      <pre
        key={item.id}
        aria-label="Output so far"
        className={cn(
          "max-h-60 overflow-auto rounded-md border bg-card px-3 py-2 font-mono text-[12px] leading-relaxed whitespace-pre-wrap text-muted-foreground",
          ARRIVE,
        )}
      >
        {item.text.split("\n").slice(-LIVE_LINES).join("\n")}
      </pre>
    ),
  );
}
