import type { SessionBlock, ToolBlock } from "./session-events";

/**
 * A tool call as it is drawn: what kind of work it is, with its fields ready, the same for pi,
 * Claude Code and Codex, whatever each harness names its tools.
 */
export type ToolView =
  | {
      kind: "command";
      /** Each command it ran, in order; a Codex script may run several. */
      commands: string[];
      description?: string;
      /** A script whose commands could not be told apart: shown as it is. */
      script?: string;
    }
  | { kind: "read"; path: string; lines?: string }
  | { kind: "edit"; path: string; changes: TextChange[] }
  | { kind: "write"; path: string; text: string }
  | { kind: "patch"; files: string[]; patch: string }
  | { kind: "search"; pattern: string; path?: string }
  | { kind: "web"; query?: string; url?: string }
  | { kind: "agent"; title: string; prompt?: string }
  | { kind: "plan"; steps: PlanStep[] }
  | {
      kind: "zerolux";
      action: "send" | "reply" | "inbox" | "thread" | "close" | "reload";
      chat?: string;
      text?: string;
      title?: string;
    }
  | {
      kind: "mcp";
      server: string;
      tool: string;
      args: Record<string, unknown>;
    }
  | { kind: "other"; name: string; args: unknown };

export interface TextChange {
  before: string;
  after: string;
}
export interface PlanStep {
  text: string;
  status: "pending" | "active" | "done";
}

/** A short line for what a tool was given: its command, path, pattern, query or first text. */
export function toolLine(input: unknown): string {
  if (!input || typeof input !== "object") return "";
  const fields = input as Record<string, unknown>;
  const first =
    fields.command ??
    fields.file_path ??
    fields.path ??
    fields.pattern ??
    fields.query ??
    Object.values(fields).find((value) => typeof value === "string");
  return typeof first === "string" ? first : "";
}

const text = (value: unknown) => (typeof value === "string" ? value : "");
const fields = (input: unknown): Record<string, unknown> =>
  input && typeof input === "object" && !Array.isArray(input)
    ? (input as Record<string, unknown>)
    : {};

/** Lines a read covers, from an offset and a limit. */
function lines(offset: unknown, limit: unknown) {
  const from = typeof offset === "number" ? offset : undefined;
  const count = typeof limit === "number" ? limit : undefined;
  if (from === undefined && count === undefined) return undefined;
  const start = from ?? 1;
  return count === undefined
    ? `from line ${start}`
    : `lines ${start}–${start + count - 1}`;
}

/** The commands a Codex script runs through `exec_command`, in order. */
function scriptCommands(script: string) {
  const commands: string[] = [];
  for (const match of script.matchAll(
    /exec_command\(\s*\{\s*"?cmd"?\s*:\s*("(?:[^"\\]|\\.)*")/g,
  ))
    try {
      commands.push(JSON.parse(match[1]!) as string);
    } catch {
      // A literal JSON cannot read stays out; the script is still shown.
    }
  return commands;
}

const ZEROLUX = {
  send: "send",
  reply: "reply",
  inbox: "inbox",
  thread: "thread",
  close_thread: "close",
  reload: "reload",
} as const;

const PLAN = {
  pending: "pending",
  in_progress: "active",
  completed: "done",
} as const;

/** What a tool call is, from its name and input, for any harness. */
export function toolView(name: string, input: unknown): ToolView {
  const args = fields(input);
  const zerolux = /^(?:mcp__zerolux__|zerolux_)(\w+)$/.exec(name)?.[1];
  if (zerolux && zerolux in ZEROLUX)
    return {
      kind: "zerolux",
      action: ZEROLUX[zerolux as keyof typeof ZEROLUX],
      chat: text(args.chat) || undefined,
      text: text(args.text) || undefined,
      title: text(args.title) || undefined,
    };
  const mcp = /^mcp__(.+?)__(.+)$/.exec(name);
  if (mcp) return { kind: "mcp", server: mcp[1]!, tool: mcp[2]!, args };
  switch (name) {
    case "Bash":
    case "bash":
    case "Monitor":
      return {
        kind: "command",
        commands: [text(args.command)],
        description: text(args.description) || undefined,
      };
    case "shell":
    case "exec_command": {
      const command = args.cmd ?? args.command;
      return {
        kind: "command",
        commands: [Array.isArray(command) ? command.join(" ") : text(command)],
      };
    }
    case "exec": {
      const script = typeof input === "string" ? input : text(args.input);
      const commands = scriptCommands(script);
      return commands.length
        ? { kind: "command", commands }
        : { kind: "command", commands: [], script };
    }
    case "Read":
    case "read":
      return {
        kind: "read",
        path: text(args.file_path ?? args.path),
        lines: lines(args.offset, args.limit),
      };
    case "Edit":
    case "MultiEdit":
    case "edit": {
      const edits = Array.isArray(args.edits) ? args.edits.map(fields) : [args];
      return {
        kind: "edit",
        path: text(args.file_path ?? args.path),
        changes: edits.map((edit) => ({
          before: text(edit.old_string ?? edit.oldText),
          after: text(edit.new_string ?? edit.newText),
        })),
      };
    }
    case "Write":
    case "write":
      return {
        kind: "write",
        path: text(args.file_path ?? args.path),
        text: text(args.content),
      };
    case "apply_patch": {
      const patch = typeof input === "string" ? input : text(args.input);
      return {
        kind: "patch",
        patch,
        files: [
          ...patch.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm),
        ].map((m) => m[1]!.trim()),
      };
    }
    case "Grep":
    case "Glob":
    case "grep":
    case "find":
      return {
        kind: "search",
        pattern: text(args.pattern),
        path: text(args.path) || undefined,
      };
    case "WebSearch":
    case "web_search":
    case "web_search_claude":
    case "web_search_codex":
      return {
        kind: "web",
        query: text(args.query) || undefined,
        url: text(args.url) || undefined,
      };
    case "WebFetch":
      return { kind: "web", url: text(args.url) };
    case "Agent":
    case "Task":
    case "spawn_agent":
      return {
        kind: "agent",
        title: text(args.description ?? args.task_name) || "Subagent",
        prompt: text(args.prompt ?? args.message) || undefined,
      };
    case "TodoWrite":
    case "update_plan": {
      const items = (Array.isArray(args.todos) ? args.todos : args.plan) ?? [];
      return {
        kind: "plan",
        steps: (Array.isArray(items) ? items : []).map((item) => {
          const step = fields(item);
          return {
            text: text(step.content ?? step.step),
            status: PLAN[text(step.status) as keyof typeof PLAN] ?? "pending",
          };
        }),
      };
    }
  }
  return { kind: "other", name, args: input };
}

/** What a tool gave back, read the same way for every harness. */
export interface ToolOutcome {
  /** Its text; for commands Codex runs in a script, what each command printed. */
  text: string;
  /** Its images, as data URLs. */
  images: string[];
  /** A command's exit code: the first that failed, else the last one reported. */
  exit?: number;
  /** The person, or a permission check, refused the call. */
  denied: boolean;
  timedOut: boolean;
}

const DENIED =
  /^(?:The user doesn't want to proceed with this tool use|Permission (?:for this (?:action|command)|to use .+?) (?:was|has been) denied)/;

/** What a tool gave back: plain text, content blocks, Codex command chunks, or a value as JSON. */
export function toolOutcome(output: unknown): ToolOutcome {
  const blocks =
    typeof output === "string"
      ? [{ text: output }]
      : Array.isArray(output)
        ? output.map(fields)
        : Array.isArray(fields(output).content)
          ? (fields(output).content as unknown[]).map(fields)
          : output == null
            ? []
            : [{ text: JSON.stringify(output, null, 2) }];
  const texts: string[] = [];
  const printed: string[] = [];
  const exits: number[] = [];
  const images: string[] = [];
  for (const block of blocks) {
    const source = fields(block.source);
    if (typeof block.text === "string") {
      texts.push(block.text);
      // Codex reports each command of a script as a JSON chunk.
      const chunk = codexChunk(block.text);
      if (chunk) {
        printed.push(chunk.output);
        if (chunk.exit !== undefined) exits.push(chunk.exit);
      }
    } else if (typeof source.data === "string")
      images.push(`data:${text(source.media_type)};base64,${source.data}`);
    else if (block.type === "image" && typeof block.data === "string")
      images.push(`data:${text(block.mimeType)};base64,${block.data}`);
    else if (text(block.image_url).startsWith("data:"))
      images.push(text(block.image_url));
    else if (typeof block.tool_name === "string") texts.push(block.tool_name);
    else texts.push(JSON.stringify(block, null, 2));
  }
  let all = texts
    .join("\n")
    // Codex scripts open with a header; its web results carry citation marks.
    .replace(/^Script completed\nWall time [\d.]+ seconds\nOutput:\n*/, "")
    .replace(/\ue200[^\ue201]*\ue201/g, "");
  let timedOut = /^Command timed out\b/.test(all.trimStart());
  // Claude Code writes a failed command's exit code first, pi last.
  const exit =
    /^Exit code (\d+)\n?/.exec(all) ??
    /\n*Command exited with code (\d+)\s*$/.exec(all);
  if (exit) {
    exits.push(Number(exit[1]));
    all = all.replace(exit[0], "");
  }
  const late = /\n*Command timed out after [^\n]+\s*$/.exec(all);
  if (late) {
    timedOut = true;
    all = all.slice(0, late.index);
  }
  if (all.trim() === "(no output)") all = "";
  return {
    text: (printed.length ? printed.join("\n") : all).trimEnd(),
    images,
    exit: exits.find((code) => code !== 0) ?? exits.at(-1),
    denied: DENIED.test(all.trimStart()),
    timedOut,
  };
}

function codexChunk(value: string) {
  const trimmed = value.trim();
  if (!trimmed.startsWith("{")) return undefined;
  try {
    const parsed = fields(JSON.parse(trimmed));
    const chunk = parsed.value ? fields(parsed.value) : parsed;
    if (typeof chunk.output !== "string") return undefined;
    return {
      output: chunk.output,
      exit: typeof chunk.exit_code === "number" ? chunk.exit_code : undefined,
    };
  } catch {
    return undefined;
  }
}

/** How many lines an edit adds and removes, for its one-line summary. */
export function changeCount(changes: TextChange[]) {
  const count = (value: string) => (value ? value.split("\n").length : 0);
  return changes.reduce(
    (sum, change) => ({
      added: sum.added + count(change.after),
      removed: sum.removed + count(change.before),
    }),
    { added: 0, removed: 0 },
  );
}

/** How many lines a patch adds and removes. */
export function patchCount(patch: string) {
  const rows = patch.split("\n");
  return {
    added: rows.filter((row) => row.startsWith("+")).length,
    removed: rows.filter((row) => row.startsWith("-")).length,
  };
}

/** One line of a change: kept as it was, added, or removed. */
export interface DiffLine {
  kind: "same" | "added" | "removed";
  text: string;
}

/**
 * A change line by line: the lines both sides keep, and in between what went and what came.
 * Past a size a full comparison would take too long, so it shows all that went, then all that came.
 */
export function diffLines(before: string, after: string): DiffLine[] {
  const a = before ? before.split("\n") : [];
  const b = after ? after.split("\n") : [];
  if (a.length * b.length > 250_000)
    return [
      ...a.map((line) => ({ kind: "removed" as const, text: line })),
      ...b.map((line) => ({ kind: "added" as const, text: line })),
    ];
  // Longest common subsequence, from the end, so the walk below reads forward.
  const keep = Array.from({ length: a.length + 1 }, () =>
    new Array<number>(b.length + 1).fill(0),
  );
  for (let i = a.length - 1; i >= 0; i--)
    for (let j = b.length - 1; j >= 0; j--)
      keep[i]![j] =
        a[i] === b[j]
          ? keep[i + 1]![j + 1]! + 1
          : Math.max(keep[i + 1]![j]!, keep[i]![j + 1]!);
  const lines: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      lines.push({ kind: "same", text: a[i]! });
      i++;
      j++;
    } else if (
      i < a.length &&
      (j === b.length || keep[i + 1]![j]! >= keep[i]![j + 1]!)
    ) {
      lines.push({ kind: "removed", text: a[i]! });
      i++;
    } else {
      lines.push({ kind: "added", text: b[j]! });
      j++;
    }
  }
  return lines;
}

/** A message's first line as plain words, for a one-line preview: no Markdown marks. */
export function plainLine(text: string) {
  const line = text.split("\n").find((row) => row.trim()) ?? "";
  return line
    .replace(/^\s*(?:#{1,6}\s+|>\s*|[-*+]\s+|\d+\.\s+)/, "")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/(\*\*|__)(.+?)\1/g, "$2")
    .replace(/\*(\S(?:.*?\S)?)\*/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .trim();
}

const host = (url: string) => {
  try {
    const { host, pathname } = new URL(url);
    return host + pathname.replace(/\/$/, "");
  } catch {
    return url;
  }
};

/**
 * A tool in a few words: a verb in the tense of its state ("Running", "Ran") and what it works
 * on, as plain text. `chatTitle` names the chats ZeroLux tools write in.
 */
export function toolPhrase(
  view: ToolView,
  running: boolean,
  chatTitle?: (id: string) => string | undefined,
): { verb: string; subject?: string } {
  const tense = (now: string, done: string) => (running ? now : done);
  switch (view.kind) {
    case "command":
      return {
        verb: tense("Running", "Ran"),
        subject: view.commands[0] ?? view.script?.split("\n")[0],
      };
    case "read":
      return { verb: tense("Reading", "Read"), subject: view.path };
    case "edit":
      return { verb: tense("Editing", "Edited"), subject: view.path };
    case "write":
      return { verb: tense("Writing", "Wrote"), subject: view.path };
    case "patch":
      return { verb: tense("Patching", "Patched"), subject: view.files[0] };
    case "search":
      return {
        verb: tense("Searching", "Searched"),
        subject: view.path ? `${view.pattern} in ${view.path}` : view.pattern,
      };
    case "web":
      return view.query
        ? {
            verb: tense("Searching the web", "Searched the web"),
            subject: view.query,
          }
        : { verb: tense("Fetching", "Fetched"), subject: host(view.url ?? "") };
    case "agent":
      return { verb: tense("Delegating", "Delegated"), subject: view.title };
    case "plan":
      return {
        verb: "Plan",
        subject: view.steps.find((step) => step.status === "active")?.text,
      };
    case "zerolux": {
      const place = (view.chat && chatTitle?.(view.chat)) || "a chat";
      const said = view.text && plainLine(view.text);
      switch (view.action) {
        case "send":
          return {
            verb: tense(`Writing in ${place}`, `Wrote in ${place}`),
            subject: said,
          };
        case "reply":
          return { verb: tense("Replying", "Replied"), subject: said };
        case "inbox":
          return { verb: tense("Reading the inbox", "Read the inbox") };
        case "thread":
          return {
            verb: tense("Opening a thread", "Opened a thread"),
            subject: view.title,
          };
        case "close":
          return {
            verb: tense("Closing a thread", "Closed a thread"),
            subject: view.chat && chatTitle?.(view.chat),
          };
        case "reload":
          return { verb: tense("Reloading", "Reloaded") };
      }
      break;
    }
    case "mcp":
      return {
        verb: view.tool.replaceAll("_", " "),
        subject: toolLine(view.args),
      };
  }
  return { verb: view.name, subject: toolLine(view.args) };
}

/** Looking around rather than changing things: reading a file, listing a folder, searching. */
export type Exploration = "read" | "list" | "search";

const EXPLORE: Record<string, Exploration> = {
  cat: "read",
  head: "read",
  tail: "read",
  less: "read",
  bat: "read",
  nl: "read",
  wc: "read",
  sed: "read",
  ls: "list",
  tree: "list",
  find: "list",
  fd: "list",
  du: "list",
  rg: "search",
  grep: "search",
  ag: "search",
  ack: "search",
};

/** What a shell command explores, when every part of it only looks: `cd` and pipes allowed. */
function commandExploration(command: string): Exploration | undefined {
  let found: Exploration | undefined;
  for (const part of command.split(/&&|\|\||;|\|/)) {
    const words = part.trim().split(/\s+/);
    const [word = "", next] = words;
    if (!word || word === "cd") continue;
    const kind =
      word === "git" && (next === "grep" || next === "ls-files")
        ? next === "grep"
          ? "search"
          : "list"
        : word === "sed" && next !== "-n"
          ? undefined
          : EXPLORE[word];
    if (!kind) return undefined;
    found ??= kind;
  }
  return found;
}

/** What a tool explores, if it only looks around; anything that changes or runs things is not. */
export function exploration(view: ToolView): Exploration | undefined {
  if (view.kind === "read") return "read";
  if (view.kind === "search") return "search";
  if (view.kind !== "command" || !view.commands.length) return undefined;
  const kinds = view.commands.map(commandExploration);
  return kinds.every(Boolean) ? kinds[0] : undefined;
}

/** Explorations one after another, drawn as one line that opens on each of them. */
export interface Explored {
  kind: "explored";
  key: string;
  tools: ToolBlock[];
}

/** A run of tools as it is listed: two or more explorations in a row fold into one line. */
export function toolItems(tools: ToolBlock[]): (ToolBlock | Explored)[] {
  const items: (ToolBlock | Explored)[] = [];
  let group: ToolBlock[] = [];
  const close = () => {
    if (group.length > 1)
      items.push({ kind: "explored", key: group[0]!.key, tools: group });
    else items.push(...group);
    group = [];
  };
  for (const tool of tools) {
    if (exploration(toolView(tool.name, tool.input)) && !tool.result?.error)
      group.push(tool);
    else {
      close();
      items.push(tool);
    }
  }
  close();
  return items;
}

/** A folded exploration in a few words: "Explored 3 files, 2 searches". */
export function exploredPhrase(tools: ToolBlock[]) {
  const running = tools.some((tool) => !tool.result && !tool.stopped);
  const files = new Set<string>();
  let reads = 0;
  let lists = 0;
  let searches = 0;
  for (const tool of tools) {
    const view = toolView(tool.name, tool.input);
    const kind = exploration(view);
    if (kind === "read" && view.kind === "read") files.add(view.path);
    else if (kind === "read") reads++;
    else if (kind === "list") lists++;
    else if (kind === "search") searches++;
  }
  const count = (n: number, one: string, many: string) =>
    n ? `${n} ${n === 1 ? one : many}` : "";
  return {
    verb: running ? "Exploring" : "Explored",
    subject: [
      count(files.size + reads, "file", "files"),
      count(lists, "folder", "folders"),
      count(searches, "search", "searches"),
    ]
      .filter(Boolean)
      .join(", "),
  };
}

/**
 * Where a tool stands: still running, stopped with its turn, refused, failed, or done. A
 * search that found nothing (exit 1) is done, not failed.
 */
export function toolState(
  tool: ToolBlock,
  view: ToolView,
  outcome: ToolOutcome | undefined,
): "running" | "stopped" | "denied" | "error" | "done" {
  if (!tool.result) return tool.stopped ? "stopped" : "running";
  if (outcome?.denied) return "denied";
  const exit = outcome?.exit ?? 0;
  const empty = exit === 1 && exploration(view) === "search";
  return tool.result.error || (exit !== 0 && !empty) || outcome?.timedOut
    ? "error"
    : "done";
}

/** The plan a session laid out last (TodoWrite, update_plan): its steps as they stand now. */
export function latestPlan(blocks: SessionBlock[]): PlanStep[] | undefined {
  for (let i = blocks.length - 1; i >= 0; i--) {
    const block = blocks[i]!;
    if (block.kind !== "tool") continue;
    const view = toolView(block.name, block.input);
    if (view.kind === "plan") return view.steps;
  }
  return undefined;
}

/** A subagent's call: its work is drawn as a card of its own, not as a line among tools. */
export const isSubagent = (tool: ToolBlock) =>
  toolView(tool.name, tool.input).kind === "agent";

/** Tools run one after another, in a few words: "Ran 3 commands · edited 2 files · read 4 files". */
export function toolsPhrase(tools: ToolBlock[]): string {
  const count = {
    commands: 0,
    reads: 0,
    searches: 0,
    web: 0,
    messages: 0,
    mcp: 0,
    plans: 0,
    other: 0,
  };
  const edited = new Set<string>();
  for (const tool of tools) {
    const view = toolView(tool.name, tool.input);
    if (view.kind === "command") count.commands++;
    else if (view.kind === "edit" || view.kind === "write")
      edited.add(view.path);
    else if (view.kind === "patch")
      view.files.forEach((file) => edited.add(file));
    else if (view.kind === "read") count.reads++;
    else if (view.kind === "search") count.searches++;
    else if (view.kind === "web") count.web++;
    else if (view.kind === "zerolux") count.messages++;
    else if (view.kind === "mcp") count.mcp++;
    else if (view.kind === "plan") count.plans++;
    else count.other++;
  }
  const part = (n: number, one: string, many: string) =>
    n ? `${n} ${n === 1 ? one : many}` : "";
  const parts = [
    part(count.commands, "command", "commands") &&
      `ran ${part(count.commands, "command", "commands")}`,
    part(edited.size, "file", "files") &&
      `edited ${part(edited.size, "file", "files")}`,
    part(count.reads, "file", "files") &&
      `read ${part(count.reads, "file", "files")}`,
    part(count.searches, "search", "searches"),
    part(count.web, "web lookup", "web lookups"),
    part(count.messages, "ZeroLux message", "ZeroLux messages"),
    part(count.mcp, "MCP tool", "MCP tools") &&
      `called ${part(count.mcp, "MCP tool", "MCP tools")}`,
    count.plans ? "updated the plan" : "",
    part(count.other, "tool", "tools") &&
      `used ${part(count.other, "tool", "tools")}`,
  ].filter(Boolean);
  const phrase = parts.join(" · ");
  return phrase && phrase[0]!.toUpperCase() + phrase.slice(1);
}
