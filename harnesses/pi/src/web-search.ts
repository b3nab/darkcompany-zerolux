// Web search through the Claude Code and Codex CLIs, which carry their own web search.
// Each call runs the CLI isolated in a temporary directory: no project instructions, no
// global memory rituals, no shell. Quick mode returns cited results as JSON; research mode
// writes a Markdown report under .zerolux/research/ and returns its path with an abstract.
// The tool row shows what runs (provider, mode, model, effort, query), each search and
// fetch as it happens, then the answer with numbered links.
import { Type } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { spawn } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

export type Provider = "claude" | "codex";
export type Mode = "quick" | "research";

export interface SearchRequest {
  query: string;
  mode: Mode;
  model?: string;
  effort?: string;
  maxResults: number;
}

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

export interface QuickOutcome {
  mode: "quick";
  answer: string;
  results: SearchResult[];
}

export interface ResearchOutcome {
  mode: "research";
  path: string;
  abstract: string;
}

export type Outcome = QuickOutcome | ResearchOutcome;

/** One thing the CLI did on the web, as shown while the search runs. */
export interface Step {
  kind: "search" | "fetch";
  text: string;
}

/** What the tool row renders, partial while running and complete at the end. */
export interface Details {
  provider: Provider;
  mode: Mode;
  model?: string;
  effort?: string;
  query: string;
  steps: Step[];
  elapsedMs: number;
  outcome?: Outcome;
}

export interface RunOptions {
  cwd: string;
  env: Record<string, string>;
  stdin: string;
  signal: AbortSignal | undefined;
  timeoutMs: number;
  /** Each complete line of stdout, as it arrives. */
  onLine?: (line: string) => void;
}

export interface RunOutcome {
  code: number;
  stdout: string;
  stderr: string;
}

export type Runner = (
  cmd: string,
  args: string[],
  options: RunOptions,
) => Promise<RunOutcome>;

export interface Deps {
  run: Runner;
  /** Where research reports go; created on demand. */
  researchDir: string;
  /** The user's Codex home with auth.json, linked into the isolated one. */
  codexHome: string;
  now: () => Date;
}

export const TIMEOUTS: Record<Mode, number> = {
  quick: 120_000,
  research: 600_000,
};

const CLAUDE_EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
const CODEX_EFFORTS = ["minimal", "low", "medium", "high", "xhigh"] as const;

export const quickSchema = {
  type: "object",
  properties: {
    answer: { type: "string" },
    results: {
      type: "array",
      items: {
        type: "object",
        properties: {
          title: { type: "string" },
          url: { type: "string" },
          snippet: { type: "string" },
        },
        required: ["title", "url", "snippet"],
        additionalProperties: false,
      },
    },
  },
  required: ["answer", "results"],
  additionalProperties: false,
} as const;

const SYSTEM_PROMPT =
  "You are a web research tool. Use web search and page fetching to answer from current, verifiable sources. Never run commands, never read or write local files, never ask questions back. Prefer primary sources and give the date of what you find.";

export function quickPrompt(request: SearchRequest): string {
  return `Research this query on the web and answer it: ${request.query}\n\nReturn a concise answer with inline citations in the form (source: URL), then up to ${request.maxResults} results, each with the page title, its URL and a snippet of what it says about the query. Only include results you actually consulted.`;
}

export function researchPrompt(request: SearchRequest): string {
  return `Research this topic on the web thoroughly, using several searches and fetching the most relevant pages: ${request.query}\n\nWrite a complete Markdown report: a title, a short abstract, the findings organized in sections, disagreements between sources, and a final "Sources" section listing every URL you used. Cite sources inline as [n] linked to that list. Output the report only, with no preamble.`;
}

export function validateEffort(
  provider: Provider,
  effort: string | undefined,
): void {
  if (effort === undefined) return;
  const allowed: readonly string[] =
    provider === "claude" ? CLAUDE_EFFORTS : CODEX_EFFORTS;
  if (!allowed.includes(effort))
    throw new Error(
      `Effort ${JSON.stringify(effort)} is not valid for ${provider}; use one of ${allowed.join(", ")}`,
    );
}

export function claudeArgs(request: SearchRequest): string[] {
  const args = [
    "-p",
    "--output-format",
    "stream-json",
    "--verbose",
    "--setting-sources",
    "",
    "--tools",
    "WebSearch,WebFetch",
    // No MCP servers at all, not even the claude.ai account connectors.
    "--strict-mcp-config",
    "--permission-mode",
    "bypassPermissions",
    "--system-prompt",
    SYSTEM_PROMPT,
  ];
  if (request.mode === "quick")
    args.push("--json-schema", JSON.stringify(quickSchema));
  if (request.model) args.push("--model", request.model);
  if (request.effort) args.push("--effort", request.effort);
  return args;
}

export function codexArgs(
  request: SearchRequest,
  files: { schema: string; last: string },
): string[] {
  const args = [
    "exec",
    "--ephemeral",
    "--skip-git-repo-check",
    "--sandbox",
    "read-only",
    "--json",
    "--output-last-message",
    files.last,
  ];
  if (request.mode === "quick") args.push("--output-schema", files.schema);
  if (request.model) args.push("--model", request.model);
  if (request.effort)
    args.push(
      "--config",
      `model_reasoning_effort=${JSON.stringify(request.effort)}`,
    );
  return args;
}

function parseLine(line: string): unknown {
  try {
    return JSON.parse(line);
  } catch {
    return undefined;
  }
}

/** The web steps in one line of Claude's stream-json: WebSearch and WebFetch tool uses. */
export function claudeSteps(line: string): Step[] {
  const event = parseLine(line) as
    | { type?: string; message?: { content?: unknown } }
    | undefined;
  if (event?.type !== "assistant" || !Array.isArray(event.message?.content))
    return [];
  const steps: Step[] = [];
  for (const block of event.message.content as {
    type?: string;
    name?: string;
    input?: { query?: unknown; url?: unknown };
  }[]) {
    if (block.type !== "tool_use") continue;
    if (block.name === "WebSearch" && typeof block.input?.query === "string")
      steps.push({ kind: "search", text: block.input.query });
    if (block.name === "WebFetch" && typeof block.input?.url === "string")
      steps.push({ kind: "fetch", text: block.input.url });
  }
  return steps;
}

/** The web steps in one line of Codex's --json: completed web_search items. */
export function codexSteps(line: string): Step[] {
  const event = parseLine(line) as
    | {
        type?: string;
        item?: {
          type?: string;
          action?: { type?: string; queries?: unknown; url?: unknown };
        };
      }
    | undefined;
  if (event?.type !== "item.completed" || event.item?.type !== "web_search")
    return [];
  const action = event.item.action;
  if (Array.isArray(action?.queries))
    return action.queries
      .filter((query): query is string => typeof query === "string")
      .map((query) => ({ kind: "search", text: query }));
  if (typeof action?.url === "string")
    return [{ kind: "fetch", text: action.url }];
  return [];
}

/** Claude's stream-json: the `result` event holds the final text. */
export function claudeResult(stdout: string): string {
  type Envelope = {
    type?: string;
    is_error?: boolean;
    result?: unknown;
    subtype?: string;
  };
  let envelope: Envelope | undefined;
  for (const line of stdout.split("\n")) {
    const event = parseLine(line) as Envelope | undefined;
    if (event?.type === "result") envelope = event;
  }
  if (!envelope) throw new Error("Claude returned no result");
  if (envelope.is_error || typeof envelope.result !== "string")
    throw new Error(
      `Claude search failed${envelope.subtype ? ` (${envelope.subtype})` : ""}`,
    );
  return envelope.result;
}

export function parseQuick(text: string, maxResults: number): QuickOutcome {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("The search answer is not valid JSON");
  }
  const value = parsed as { answer?: unknown; results?: unknown };
  if (typeof value?.answer !== "string" || !Array.isArray(value.results))
    throw new Error("The search answer does not match the expected shape");
  const results = value.results
    .filter(
      (item): item is SearchResult =>
        !!item &&
        typeof item === "object" &&
        typeof (item as SearchResult).title === "string" &&
        typeof (item as SearchResult).url === "string" &&
        typeof (item as SearchResult).snippet === "string",
    )
    .slice(0, maxResults);
  return { mode: "quick", answer: value.answer, results };
}

export function slugify(query: string): string {
  const slug = query
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/g, "");
  return slug || "research";
}

export function reportName(
  query: string,
  provider: Provider,
  at: Date,
): string {
  const stamp = at
    .toISOString()
    .replace(/[:.]/g, "-")
    .replace("T", "_")
    .slice(0, 19);
  return `${stamp}_${provider}_${slugify(query)}.md`;
}

export function abstractOf(markdown: string, limit = 800): string {
  const text = markdown.trim();
  return text.length <= limit ? text : `${text.slice(0, limit).trimEnd()}…`;
}

async function withWorkspace<T>(work: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "zerolux-web-search-"));
  try {
    return await work(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export async function search(
  provider: Provider,
  request: SearchRequest,
  deps: Deps,
  signal: AbortSignal | undefined,
  onStep: (step: Step) => void = () => {},
): Promise<Outcome> {
  if (!request.query.trim()) throw new Error("The query is empty");
  validateEffort(provider, request.effort);
  const prompt =
    request.mode === "quick" ? quickPrompt(request) : researchPrompt(request);
  const timeoutMs = TIMEOUTS[request.mode];
  const steps = provider === "claude" ? claudeSteps : codexSteps;
  const onLine = (line: string) => {
    for (const step of steps(line)) onStep(step);
  };
  const text = await withWorkspace(async (dir) => {
    const cwd = join(dir, "work");
    await mkdir(cwd);
    if (provider === "claude") {
      const outcome = await deps.run("claude", claudeArgs(request), {
        cwd,
        env: {},
        stdin: prompt,
        signal,
        timeoutMs,
        onLine,
      });
      if (outcome.code !== 0)
        throw new Error(
          `Claude exited with ${outcome.code}: ${outcome.stderr.trim() || outcome.stdout.trim()}`.slice(
            0,
            500,
          ),
        );
      return claudeResult(outcome.stdout);
    }
    // An isolated CODEX_HOME keeps the user's global AGENTS.md and hooks out of the search.
    const home = join(dir, "codex-home");
    await mkdir(home);
    await symlink(join(deps.codexHome, "auth.json"), join(home, "auth.json"));
    await writeFile(join(home, "config.toml"), 'web_search = "live"\n');
    const files = {
      schema: join(dir, "schema.json"),
      last: join(dir, "last.md"),
    };
    await writeFile(files.schema, JSON.stringify(quickSchema));
    const outcome = await deps.run("codex", codexArgs(request, files), {
      cwd,
      env: { CODEX_HOME: home },
      stdin: prompt,
      signal,
      timeoutMs,
      onLine,
    });
    if (outcome.code !== 0)
      throw new Error(
        `Codex exited with ${outcome.code}: ${outcome.stderr.trim()}`.slice(
          0,
          500,
        ),
      );
    const last = await readFile(files.last, "utf8").catch(() => "");
    if (!last.trim()) throw new Error("Codex produced no final message");
    return last;
  });
  if (request.mode === "quick") return parseQuick(text, request.maxResults);
  await mkdir(deps.researchDir, { recursive: true });
  const path = join(
    deps.researchDir,
    reportName(request.query, provider, deps.now()),
  );
  await writeFile(path, text.trimEnd() + "\n");
  return { mode: "research", path, abstract: abstractOf(text) };
}

/** What the model reads. */
export function formatOutcome(outcome: Outcome): string {
  if (outcome.mode === "research")
    return `Report saved to ${outcome.path}\n\n${outcome.abstract}`;
  return JSON.stringify(outcome, null, 2);
}

/** Runs a CLI (pi runs on Node, tests on Bun), feeding the prompt on stdin and killing it on abort or timeout. */
export const spawnRunner: Runner = (cmd, args, options) =>
  new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let pending = "";
    let timedOut = false;
    const kill = () => proc.kill();
    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, options.timeoutMs);
    options.signal?.addEventListener("abort", kill, { once: true });
    const done = () => {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", kill);
    };
    proc.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      stdout += chunk;
      if (!options.onLine) return;
      pending += chunk;
      const lines = pending.split("\n");
      pending = lines.pop() ?? "";
      for (const line of lines) if (line.trim()) options.onLine(line);
    });
    proc.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      stderr += chunk;
    });
    proc.on("error", (error) => {
      done();
      reject(error);
    });
    proc.on("close", (code, signalCode) => {
      done();
      if (pending.trim()) options.onLine?.(pending);
      if (options.signal?.aborted) reject(new Error("Search cancelled"));
      else if (timedOut || (code !== 0 && signalCode))
        reject(
          new Error(`${cmd} timed out after ${options.timeoutMs / 1000}s`),
        );
      else resolve({ code: code ?? 1, stdout, stderr });
    });
    proc.stdin.on("error", () => {});
    proc.stdin.end(options.stdin);
  });

const parameters = Type.Object({
  query: Type.String({ description: "What to search or research" }),
  mode: Type.Optional(
    Type.Union([Type.Literal("quick"), Type.Literal("research")], {
      description:
        "quick (default): answer plus cited results as JSON. research: a complete Markdown report saved under .zerolux/research/, returned as path plus abstract.",
    }),
  ),
  model: Type.Optional(
    Type.String({ description: "Model for the CLI; its default when omitted" }),
  ),
  effort: Type.Optional(
    Type.String({
      description:
        "Reasoning effort: claude low|medium|high|xhigh|max, codex minimal|low|medium|high|xhigh",
    }),
  ),
  max_results: Type.Optional(
    Type.Number({
      description: "Results in quick mode, default 8",
      minimum: 1,
      maximum: 20,
    }),
  ),
});

type Args = {
  query: string;
  mode?: Mode;
  model?: string;
  effort?: string;
  max_results?: number;
};

/** Minimal theme surface used by the renderers, so tests need no TUI. */
export interface Palette {
  fg(color: string, text: string): string;
  bold(text: string): string;
}

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

function seconds(ms: number): string {
  return `${Math.round(ms / 1000)}s`;
}

/** The tool row: `web search  claude · quick · sonnet · low` and the query. */
export function formatCall(
  provider: Provider,
  args: Partial<Args> | undefined,
  theme: Palette,
): string {
  const parts: string[] = [provider, args?.mode ?? "quick"];
  if (args?.model) parts.push(args.model);
  if (args?.effort) parts.push(args.effort);
  if (args?.max_results !== undefined)
    parts.push(`${args.max_results} results`);
  return (
    theme.fg("toolTitle", theme.bold("web search")) +
    " " +
    theme.fg("accent", parts.join(" · ")) +
    "\n" +
    theme.fg("toolOutput", args?.query ?? "")
  );
}

function stepLines(steps: Step[], theme: Palette, limit: number): string[] {
  const shown = steps.slice(-limit);
  const lines = shown.map(
    (step) =>
      theme.fg("muted", step.kind === "search" ? "  search " : "  fetch  ") +
      theme.fg("toolOutput", step.text),
  );
  if (steps.length > shown.length)
    lines.unshift(theme.fg("muted", `  … ${steps.length - shown.length} more`));
  return lines;
}

/** Below the row: steps while running, then the answer with numbered links or the report. */
export function formatResult(
  details: Details | undefined,
  options: { expanded: boolean; isPartial: boolean },
  theme: Palette,
  tick = 0,
): string {
  if (!details) return "";
  const lines: string[] = [];
  const stepLimit = options.expanded ? details.steps.length : 6;
  if (options.isPartial) {
    const spinner = SPINNER[tick % SPINNER.length]!;
    lines.push(
      theme.fg(
        "muted",
        `${spinner} searching the web, ${details.steps.length} steps, ${seconds(details.elapsedMs)}`,
      ),
    );
    lines.push(...stepLines(details.steps, theme, stepLimit));
    return lines.join("\n");
  }
  lines.push(
    theme.fg(
      "muted",
      `done in ${seconds(details.elapsedMs)}, ${details.steps.length} steps`,
    ),
  );
  if (options.expanded)
    lines.push(...stepLines(details.steps, theme, stepLimit));
  const outcome = details.outcome;
  if (!outcome) return lines.join("\n");
  if (outcome.mode === "research") {
    lines.push(theme.fg("accent", outcome.path));
    const abstract = outcome.abstract.split("\n");
    const shown = options.expanded ? abstract : abstract.slice(0, 6);
    lines.push(...shown.map((line) => theme.fg("toolOutput", line)));
    if (shown.length < abstract.length) lines.push(theme.fg("muted", "  …"));
    return lines.join("\n");
  }
  const answer = outcome.answer.split("\n");
  const shownAnswer = options.expanded ? answer : answer.slice(0, 8);
  lines.push(...shownAnswer.map((line) => theme.fg("toolOutput", line)));
  if (shownAnswer.length < answer.length) lines.push(theme.fg("muted", "  …"));
  outcome.results.forEach((result, index) => {
    lines.push(
      theme.fg("muted", `  [${index + 1}] `) +
        theme.fg("mdLink", result.title) +
        " " +
        theme.fg("mdLinkUrl", result.url),
    );
    if (options.expanded && result.snippet)
      lines.push(theme.fg("dim", `      ${result.snippet}`));
  });
  return lines.join("\n");
}

export function defaultDeps(cwd: string): Deps {
  return {
    run: spawnRunner,
    researchDir: join(cwd, ".zerolux", "research"),
    codexHome: process.env.CODEX_HOME ?? join(homedir(), ".codex"),
    now: () => new Date(),
  };
}

export default function webSearch(
  pi: ExtensionAPI,
  deps: (cwd: string) => Deps = defaultDeps,
) {
  for (const provider of ["claude", "codex"] as const) {
    const cli = provider === "claude" ? "Claude Code" : "Codex";
    pi.registerTool<typeof parameters, Details>({
      name: `web_search_${provider}`,
      label: `Web search (${cli})`,
      description: `Search the web through the ${cli} CLI and its built-in web search. Use quick mode for a cited answer, research mode for an in-depth Markdown report. Each call costs a model run; pick model and effort to match the question.`,
      parameters,
      executionMode: "parallel",
      async execute(_id, args, signal, onUpdate, ctx) {
        const started = Date.now();
        const details: Details = {
          provider,
          mode: args.mode ?? "quick",
          model: args.model,
          effort: args.effort,
          query: args.query,
          steps: [],
          elapsedMs: 0,
        };
        const update = () => {
          details.elapsedMs = Date.now() - started;
          // A copy per update: the UI keeps the last partial, the steps keep growing.
          onUpdate?.({
            content: [],
            details: { ...details, steps: [...details.steps] },
          });
        };
        // A heartbeat keeps the elapsed time and spinner moving between steps.
        const heartbeat = setInterval(update, 1000);
        try {
          update();
          const outcome = await search(
            provider,
            {
              query: args.query,
              mode: details.mode,
              model: args.model,
              effort: args.effort,
              maxResults: args.max_results ?? 8,
            },
            deps(ctx.cwd),
            signal,
            (step) => {
              details.steps.push(step);
              update();
            },
          );
          details.outcome = outcome;
          details.elapsedMs = Date.now() - started;
          return {
            content: [{ type: "text", text: formatOutcome(outcome) }],
            details,
          };
        } finally {
          clearInterval(heartbeat);
        }
      },
      renderCall(args, theme, context) {
        const text =
          (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
        text.setText(formatCall(provider, args, theme));
        return text;
      },
      renderResult(result, options, theme, context) {
        const text =
          (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
        const state = context.state as { tick?: number };
        state.tick = (state.tick ?? 0) + 1;
        text.setText(
          formatResult(result.details ?? undefined, options, theme, state.tick),
        );
        return text;
      },
    });
  }
}
