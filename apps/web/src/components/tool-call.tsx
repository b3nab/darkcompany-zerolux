import { useEffect, useId, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { cn } from "cn";
import {
  BanIcon,
  BotIcon,
  CheckIcon,
  ChevronRightIcon,
  CircleAlertIcon,
  CircleCheckIcon,
  CircleDotIcon,
  CircleIcon,
  CircleSlashIcon,
  CopyIcon,
  FilePenIcon,
  FilePlusIcon,
  FileTextIcon,
  GlobeIcon,
  ListChecksIcon,
  LoaderIcon,
  MessageSquareIcon,
  PlugIcon,
  SearchIcon,
  SquareTerminalIcon,
  TelescopeIcon,
  WrenchIcon,
} from "lucide-react";
import { Link } from "react-router";
import {
  changeCount,
  diffLines,
  exploredPhrase,
  plainLine,
  spanLabel,
  toolOutcome,
  toolPhrase,
  toolState,
  toolView,
} from "@zerolux/chat";
import type { PlanStep, ToolBlock, ToolOutcome, ToolView } from "@zerolux/chat";
import { MessageText } from "@/components/message-text";
import { Reveal } from "@/components/reveal";
import { useOpen } from "@/components/density";

/** How a chat is named where a tool names it by id. */
export type ChatTitle = (id: string | null) => string | undefined;

/**
 * One tool call: a line saying what it does or did, open for what it was given and what came
 * back, drawn for its kind: a command, a file, a search, a ZeroLux message, an MCP tool.
 */
export function ToolCall({
  tool,
  chatTitle,
}: {
  tool: ToolBlock;
  chatTitle?: ChatTitle;
}) {
  const view = useMemo(
    () => toolView(tool.name, tool.input),
    [tool.name, tool.input],
  );
  const outcome = useMemo(
    () => tool.result && toolOutcome(tool.result.output),
    [tool.result],
  );
  const state = toolState(tool, view, outcome);
  const [open, setOpen] = useOpen();
  const panel = useId();
  const line = summary(view, outcome, state === "running", chatTitle);
  return (
    <div data-state={state}>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={panel}
        onClick={() => setOpen(!open)}
        className="group/tool flex w-full items-center gap-2 px-3 py-2 text-left transition-colors outline-none hover:bg-accent/50 focus-visible:bg-accent/50"
      >
        <span className="flex size-4 shrink-0 items-center justify-center">
          {state === "running" ? (
            <LoaderIcon
              aria-label="Running"
              className="size-3.5 animate-spin text-agent motion-reduce:animate-none"
            />
          ) : state === "error" ? (
            <CircleAlertIcon
              aria-label="Failed"
              className="size-3.5 text-destructive animate-in zoom-in-50 fade-in"
            />
          ) : state === "denied" ? (
            <BanIcon
              aria-label="Declined"
              className="size-3.5 text-attention animate-in zoom-in-50 fade-in"
            />
          ) : state === "stopped" ? (
            <CircleSlashIcon
              aria-label="Stopped"
              className="size-3.5 text-faint"
            />
          ) : (
            <KindIcon
              view={view}
              className="size-3.5 text-faint animate-in zoom-in-75 fade-in"
            />
          )}
        </span>
        <span
          className={cn(
            "shrink-0 text-[13px] font-medium",
            state === "running" && "sweep",
          )}
        >
          {state === "denied"
            ? "Declined"
            : state === "stopped"
              ? "Stopped"
              : line.verb}
        </span>
        <span className="min-w-0 truncate font-mono text-[12px] text-muted-foreground">
          {line.subject}
        </span>
        <span className="ml-auto flex shrink-0 items-center gap-2 pl-2 font-mono text-[11px] text-faint">
          {line.meta}
          <Elapsed tool={tool} />
          <ChevronRightIcon
            aria-hidden
            className="size-3.5 opacity-0 transition-[rotate,opacity] group-hover/tool:opacity-100 group-focus-visible/tool:opacity-100 group-aria-expanded/tool:rotate-90 group-aria-expanded/tool:opacity-100 motion-reduce:transition-none"
          />
        </span>
      </button>
      <Reveal open={open} id={panel}>
        <div className="flex flex-col gap-2 border-t px-3 py-2.5">
          <Body
            view={view}
            tool={tool}
            outcome={outcome}
            chatTitle={chatTitle}
          />
        </div>
      </Reveal>
    </div>
  );
}

/**
 * Reads, lists and searches one after another, as one line: "Explored 3 files, 2 searches".
 * Opened, each of them on its own row.
 */
export function ExploredCalls({
  tools,
  chatTitle,
}: {
  tools: ToolBlock[];
  chatTitle?: ChatTitle;
}) {
  const [open, setOpen] = useOpen();
  const panel = useId();
  const { verb, subject } = exploredPhrase(tools);
  const running = verb === "Exploring";
  return (
    <div>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={panel}
        onClick={() => setOpen(!open)}
        className="group/tool flex w-full items-center gap-2 px-3 py-2 text-left transition-colors outline-none hover:bg-accent/50 focus-visible:bg-accent/50"
      >
        <span className="flex size-4 shrink-0 items-center justify-center">
          {running ? (
            <LoaderIcon
              aria-label="Running"
              className="size-3.5 animate-spin text-agent motion-reduce:animate-none"
            />
          ) : (
            <TelescopeIcon
              aria-hidden
              className="size-3.5 text-faint animate-in zoom-in-75 fade-in"
            />
          )}
        </span>
        <span
          className={cn("shrink-0 text-[13px] font-medium", running && "sweep")}
        >
          {verb}
        </span>
        <span className="min-w-0 truncate text-[12.5px] text-muted-foreground">
          {subject}
        </span>
        <ChevronRightIcon
          aria-hidden
          className="ml-auto size-3.5 shrink-0 text-faint opacity-0 transition-[rotate,opacity] group-hover/tool:opacity-100 group-focus-visible/tool:opacity-100 group-aria-expanded/tool:rotate-90 group-aria-expanded/tool:opacity-100 motion-reduce:transition-none"
        />
      </button>
      <Reveal open={open} id={panel}>
        <div className="ml-5 divide-y border-t border-l">
          {tools.map((tool) => (
            <ToolCall key={tool.key} tool={tool} chatTitle={chatTitle} />
          ))}
        </div>
      </Reveal>
    </div>
  );
}

/**
 * A subagent the session started: a card of its own under the session's work, with its task,
 * where it stands, and what it brought back.
 */
export function SubagentCard({
  tool,
  chatTitle,
  openWork,
}: {
  tool: ToolBlock;
  chatTitle?: ChatTitle;
  /** Opens the subagent's own work, step by step, where its harness records it. */
  openWork?: () => void;
}) {
  const view = toolView(tool.name, tool.input);
  const outcome = useMemo(
    () => tool.result && toolOutcome(tool.result.output),
    [tool.result],
  );
  const state = toolState(tool, view, outcome);
  const [open, setOpen] = useOpen();
  const panel = useId();
  if (view.kind !== "agent")
    return <ToolCall tool={tool} chatTitle={chatTitle} />;
  const running = state === "running";
  return (
    <div
      data-state={state}
      className="ml-3 overflow-hidden rounded-md border border-l-2 border-agent/20 border-l-agent/50 bg-agent/5 text-sm"
    >
      <button
        type="button"
        aria-expanded={open}
        aria-controls={panel}
        onClick={() => setOpen(!open)}
        className="group/tool flex w-full items-center gap-2 px-3 py-2 text-left transition-colors outline-none hover:bg-agent/10 focus-visible:bg-agent/10"
      >
        <span className="flex size-4 shrink-0 items-center justify-center">
          {running ? (
            <LoaderIcon
              aria-label="Running"
              className="size-3.5 animate-spin text-agent motion-reduce:animate-none"
            />
          ) : state === "error" ? (
            <CircleAlertIcon
              aria-label="Failed"
              className="size-3.5 text-destructive"
            />
          ) : (
            <BotIcon aria-hidden className="size-3.5 text-agent" />
          )}
        </span>
        <span className="shrink-0 font-mono text-[11px] text-agent-foreground/80 uppercase tracking-wide">
          Subagent
        </span>
        <span
          className={cn(
            "min-w-0 truncate text-[13px] font-medium",
            running && "sweep",
          )}
        >
          {view.title}
        </span>
        <span className="ml-auto flex shrink-0 items-center gap-2 pl-2 font-mono text-[11px] text-faint">
          <Elapsed tool={tool} />
          <ChevronRightIcon
            aria-hidden
            className="size-3.5 transition-transform group-aria-expanded/tool:rotate-90 motion-reduce:transition-none"
          />
        </span>
      </button>
      {!open && view.prompt && (
        <p className="-mt-1 truncate px-3 pb-2 pl-9 text-[12.5px] text-muted-foreground">
          {plainLine(view.prompt)}
        </p>
      )}
      <Reveal open={open} id={panel}>
        <div className="flex flex-col gap-2 border-t border-agent/15 px-3 py-2.5">
          {view.prompt && (
            <p className="text-[13px] whitespace-pre-wrap text-muted-foreground">
              {view.prompt}
            </p>
          )}
          {outcome?.text ? (
            <div className="border-t border-agent/15 pt-2">
              <MessageText text={outcome.text} />
            </div>
          ) : running ? (
            <p className="text-[12.5px] text-faint">Working…</p>
          ) : null}
        </div>
      </Reveal>
      {openWork && (
        <button
          type="button"
          onClick={openWork}
          className="w-full border-t border-agent/15 px-3 py-1.5 pl-9 text-left font-mono text-[11px] text-agent-foreground/80 transition-colors outline-none hover:bg-agent/10 focus-visible:bg-agent/10"
        >
          Open its work →
        </button>
      )}
    </div>
  );
}

function KindIcon({ view, className }: { view: ToolView; className: string }) {
  const Icon = {
    command: SquareTerminalIcon,
    read: FileTextIcon,
    edit: FilePenIcon,
    write: FilePlusIcon,
    patch: FilePenIcon,
    search: SearchIcon,
    web: GlobeIcon,
    agent: BotIcon,
    plan: ListChecksIcon,
    zerolux: MessageSquareIcon,
    mcp: PlugIcon,
    other: WrenchIcon,
  }[view.kind];
  return <Icon aria-hidden className={className} />;
}

/** A path as read at a glance: the file's name, its folder fainter. */
function Path({ path }: { path: string }) {
  const cut = path.lastIndexOf("/") + 1;
  return (
    <span title={path}>
      <span className="text-faint">{path.slice(0, cut)}</span>
      <span className="text-foreground">{path.slice(cut)}</span>
    </span>
  );
}

/**
 * The line of a tool: the shared phrase (a verb in the tense of its state, what it worked on),
 * with paths drawn as paths and a measure on the right.
 */
function summary(
  view: ToolView,
  outcome: ToolOutcome | undefined,
  running: boolean,
  chatTitle?: ChatTitle,
): { verb: string; subject?: ReactNode; meta?: ReactNode } {
  const { verb, subject } = toolPhrase(view, running, chatTitle);
  const line = { verb, subject: subject as ReactNode };
  switch (view.kind) {
    case "command":
      return {
        ...line,
        meta: (
          <>
            {view.commands.length > 1 && (
              <span>+{view.commands.length - 1}</span>
            )}
            {outcome?.timedOut && (
              <span className="text-destructive">timed out</span>
            )}
            {!!outcome?.exit && (
              <span className="text-destructive">exit {outcome.exit}</span>
            )}
          </>
        ),
      };
    case "read":
      return { ...line, subject: <Path path={view.path} />, meta: view.lines };
    case "edit":
      return {
        ...line,
        subject: <Path path={view.path} />,
        meta: <Counts {...changeCount(view.changes)} />,
      };
    case "write":
      return {
        ...line,
        subject: <Path path={view.path} />,
        meta: <Counts added={view.text ? view.text.split("\n").length : 0} />,
      };
    case "patch":
      return {
        ...line,
        subject: view.files[0] && <Path path={view.files[0]} />,
        meta: view.files.length > 1 && <span>+{view.files.length - 1}</span>,
      };
    case "plan":
      return {
        ...line,
        meta: `${view.steps.filter((s) => s.status === "done").length}/${view.steps.length}`,
      };
    case "mcp":
      return {
        ...line,
        meta: <span className="rounded-xs border px-1">{view.server}</span>,
      };
  }
  return line;
}

function Counts({ added, removed }: { added: number; removed?: number }) {
  return (
    <>
      <span className="text-success">+{added}</span>
      {removed !== undefined && (
        <span className="text-destructive">−{removed}</span>
      )}
    </>
  );
}

/** How long a tool took; while it runs, how long so far, counted live. */
function Elapsed({ tool }: { tool: ToolBlock }) {
  const running = !tool.result && !tool.stopped;
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [running]);
  const start = tool.time && Date.parse(tool.time);
  if (!running && !tool.result?.time) return null;
  const end = tool.result?.time ? Date.parse(tool.result.time) : now;
  // Live, the count shows once it is worth watching; done, any second counts.
  if (!start || Number.isNaN(end) || end - start < (running ? 10_000 : 1000))
    return null;
  return <span>{spanLabel(end - start)}</span>;
}

/** What a tool was given and gave back, drawn for its kind. */
function Body({
  view,
  tool,
  outcome,
  chatTitle,
}: {
  view: ToolView;
  tool: ToolBlock;
  outcome?: ToolOutcome;
  chatTitle?: ChatTitle;
}) {
  const failed =
    tool.result?.error || !!outcome?.exit || outcome?.timedOut || undefined;
  const plain = outcome && (
    <Output text={outcome.text} images={outcome.images} failed={failed} />
  );
  // A refused call says why, whatever it is.
  if (outcome?.denied)
    return <p className="text-[13px] text-attention">{outcome.text}</p>;
  switch (view.kind) {
    case "command":
      return (
        <Terminal
          copy={view.commands.join("\n") || view.script || ""}
          failed={failed}
        >
          {view.script && !view.commands.length ? (
            <span className="text-muted-foreground">{view.script}</span>
          ) : (
            view.commands.map((command, i) => (
              <span key={i} className="block">
                <span aria-hidden className="text-faint select-none">
                  ${" "}
                </span>
                {command}
              </span>
            ))
          )}
          {view.description && (
            <span className="block text-faint"># {view.description}</span>
          )}
          {outcome?.text && (
            <span
              className={cn(
                "mt-2 block border-t pt-2 text-muted-foreground",
                failed && "text-destructive",
              )}
            >
              {outcome.text}
            </span>
          )}
        </Terminal>
      );
    case "edit":
      return (
        <>
          {view.changes.map((change, i) => (
            <Diff key={i} change={change} />
          ))}
          {failed && plain}
        </>
      );
    case "write":
      return (
        <>
          <Code>{view.text}</Code>
          {failed && plain}
        </>
      );
    case "patch":
      return (
        <Code>
          {view.patch.split("\n").map((row, i) => (
            <span
              key={i}
              className={cn(
                "block",
                row.startsWith("+") && "bg-success/10 text-success",
                row.startsWith("-") && "bg-destructive/10 text-destructive",
                row.startsWith("*** ") && "text-foreground",
                row.startsWith("@@") && "text-faint",
              )}
            >
              {row || " "}
            </span>
          ))}
        </Code>
      );
    case "agent":
      return (
        <>
          {view.prompt && (
            <p className="text-[13px] whitespace-pre-wrap text-muted-foreground">
              {view.prompt}
            </p>
          )}
          {outcome?.text && (
            <div className="border-t pt-2">
              <MessageText text={outcome.text} />
            </div>
          )}
        </>
      );
    case "plan":
      return <PlanSteps steps={view.steps} />;
    case "zerolux":
      return (
        <>
          {view.text && (
            <div className="rounded-md border-l-2 border-agent/40 bg-agent/5 px-3 py-2">
              <MessageText text={view.text} />
            </div>
          )}
          {view.chat && view.action !== "inbox" && (
            <Link
              to={`/chats/${view.chat}`}
              className="w-fit text-[12px] text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
            >
              Open {chatTitle?.(view.chat) ?? "the chat"}
            </Link>
          )}
          {(view.action === "inbox" || failed) && plain}
        </>
      );
    case "mcp":
    case "other":
      return (
        <>
          <Arguments args={view.args} />
          {plain}
        </>
      );
  }
  // Reads, searches and the web: what came back is the point.
  return plain ?? null;
}

/** A plan as a checklist: done steps struck through, the current one lit. */
export function PlanSteps({ steps }: { steps: PlanStep[] }) {
  return (
    <ul className="flex flex-col gap-1">
      {steps.map((step, i) => (
        <li key={i} className="flex items-start gap-2 text-[13px]">
          {step.status === "done" ? (
            <CircleCheckIcon className="mt-0.5 size-3.5 shrink-0 text-success" />
          ) : step.status === "active" ? (
            <CircleDotIcon className="mt-0.5 size-3.5 shrink-0 text-agent" />
          ) : (
            <CircleIcon className="mt-0.5 size-3.5 shrink-0 text-faint" />
          )}
          <span
            className={cn(
              step.status === "done" && "text-faint line-through",
              step.status === "active" && "text-agent-foreground",
            )}
          >
            {step.text}
          </span>
        </li>
      ))}
    </ul>
  );
}

/** A command and what it printed, as a terminal shows them, with a copy of the command. */
function Terminal({
  copy,
  failed,
  children,
}: {
  copy: string;
  failed?: boolean;
  children: ReactNode;
}) {
  return (
    <div
      className={cn(
        "group/terminal relative rounded-md border bg-muted/50",
        failed && "border-destructive/40",
      )}
    >
      <Copy text={copy} className="absolute top-1.5 right-1.5" />
      <pre className="max-h-80 overflow-auto px-3 py-2 pr-9 font-mono text-[12px] whitespace-pre-wrap break-words">
        {children}
      </pre>
    </div>
  );
}

function Code({ children }: { children: ReactNode }) {
  return (
    <pre className="max-h-80 overflow-auto rounded-md border bg-muted/50 px-3 py-2 font-mono text-[12px] whitespace-pre-wrap break-words">
      {children}
    </pre>
  );
}

/** One replacement in a file, line by line: kept lines faint, removed on red, added on green. */
function Diff({ change }: { change: { before: string; after: string } }) {
  const lines = useMemo(
    () => diffLines(change.before, change.after),
    [change.before, change.after],
  );
  return (
    <pre className="max-h-80 overflow-auto rounded-md border py-1 font-mono text-[12px] whitespace-pre-wrap break-words">
      {lines.map((line, i) => (
        <span
          key={i}
          className={cn(
            "flex",
            line.kind === "added" && "bg-success/10",
            line.kind === "removed" && "bg-destructive/10",
          )}
        >
          <span
            aria-hidden
            className={cn(
              "w-5 shrink-0 text-center select-none",
              line.kind === "added" && "text-success",
              line.kind === "removed" && "text-destructive",
            )}
          >
            {line.kind === "added" ? "+" : line.kind === "removed" ? "−" : ""}
          </span>
          <span
            className={cn(
              "min-w-0 flex-1",
              line.kind === "same" ? "text-faint" : "text-foreground/90",
            )}
          >
            {line.text || " "}
          </span>
        </span>
      ))}
    </pre>
  );
}

function Arguments({ args }: { args: unknown }) {
  if (args == null) return null;
  if (typeof args !== "object" || Array.isArray(args))
    return (
      <Code>
        {typeof args === "string" ? args : JSON.stringify(args, null, 2)}
      </Code>
    );
  const entries = Object.entries(args);
  if (!entries.length) return null;
  return (
    <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 font-mono text-[12px]">
      {entries.map(([key, value]) => (
        <div key={key} className="contents">
          <dt className="text-faint">{key}</dt>
          <dd className="break-words whitespace-pre-wrap text-muted-foreground">
            {typeof value === "string" ? value : JSON.stringify(value, null, 2)}
          </dd>
        </div>
      ))}
    </dl>
  );
}

/** What came back: its text, and its images, each opened in place at full size on a click. */
function Output({
  text,
  images,
  failed,
}: {
  text: string;
  images: string[];
  failed?: boolean;
}) {
  const [full, setFull] = useState<number>();
  return (
    <>
      {text && (
        <pre
          className={cn(
            "max-h-80 overflow-auto rounded-md border bg-muted/50 px-3 py-2 font-mono text-[12px] whitespace-pre-wrap break-words text-muted-foreground",
            failed && "border-destructive/40 text-destructive",
          )}
        >
          {text}
        </pre>
      )}
      {images.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {images.map((src, i) => (
            <button
              key={i}
              type="button"
              aria-label={full === i ? "Smaller" : "Larger"}
              onClick={() => setFull(full === i ? undefined : i)}
              className={cn(
                "overflow-hidden rounded-md border transition-[max-width] duration-200",
                full === i ? "max-w-full" : "max-w-48",
              )}
            >
              <img src={src} alt="" className="block h-auto w-full" />
            </button>
          ))}
        </div>
      )}
    </>
  );
}

/** Copies its text; for a moment it says so. */
export function Copy({
  text,
  className,
}: {
  text: string;
  className?: string;
}) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(timer);
  }, [copied]);
  return (
    <button
      type="button"
      aria-label={copied ? "Copied" : "Copy"}
      title={copied ? "Copied" : "Copy"}
      onClick={() =>
        void navigator.clipboard?.writeText(text).then(() => setCopied(true))
      }
      className={cn(
        "flex size-6 items-center justify-center rounded-sm text-faint opacity-0 transition-opacity group-hover/terminal:opacity-100 hover:bg-accent hover:text-foreground focus-visible:opacity-100",
        copied && "opacity-100",
        className,
      )}
    >
      {copied ? (
        <CheckIcon className="size-3.5 text-success animate-in zoom-in-50" />
      ) : (
        <CopyIcon className="size-3.5" />
      )}
    </button>
  );
}
