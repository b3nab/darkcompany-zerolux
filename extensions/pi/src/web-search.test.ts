import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import webSearch, {
  abstractOf,
  claudeArgs,
  claudeResult,
  claudeSteps,
  codexArgs,
  codexSteps,
  formatCall,
  formatResult,
  parseQuick,
  reportName,
  search,
  slugify,
  spawnRunner,
  type Deps,
  type Details,
  type RunOptions,
  type RunOutcome,
  type Runner,
} from "./web-search.ts";

const quick = {
  query: "latest tauri version",
  mode: "quick" as const,
  maxResults: 3,
};
const research = { ...quick, mode: "research" as const };
const answer = {
  answer:
    "Tauri 2.12.1 is the latest stable (source: https://crates.io/crates/tauri).",
  results: [
    {
      title: "tauri - crates.io",
      url: "https://crates.io/crates/tauri",
      snippet: "2.12.1",
    },
    {
      title: "Releases",
      url: "https://github.com/tauri-apps/tauri/releases",
      snippet: "v2.12.1",
    },
    {
      title: "Blog",
      url: "https://tauri.app/blog/tauri-2.12/",
      snippet: "2.12",
    },
    {
      title: "Extra",
      url: "https://example.com",
      snippet: "dropped by maxResults",
    },
  ],
};

/** Claude's stream-json: a web step, then the final result event. */
function claudeStream(result: unknown, extra: Record<string, unknown> = {}) {
  return [
    JSON.stringify({
      type: "assistant",
      message: {
        content: [
          { type: "tool_use", name: "WebSearch", input: { query: "tauri" } },
        ],
      },
    }),
    JSON.stringify({ type: "result", result, ...extra }),
  ].join("\n");
}

/** A fake CLI: records the call and answers like the real one would. */
function fakeRunner(
  reply: (
    cmd: string,
    args: string[],
    options: RunOptions,
  ) => Promise<Partial<RunOutcome>>,
) {
  const calls: { cmd: string; args: string[]; options: RunOptions }[] = [];
  const run: Runner = async (cmd, args, options) => {
    calls.push({ cmd, args, options });
    const outcome = await reply(cmd, args, options);
    // Like the real CLI, feed stdout line by line to the progress parser.
    for (const line of (outcome.stdout ?? "").split("\n"))
      if (line.trim()) options.onLine?.(line);
    return { code: 0, stdout: "", stderr: "", ...outcome };
  };
  return { run, calls };
}

async function withDeps(
  work: (deps: Deps, dir: string) => Promise<void>,
  run: Runner,
) {
  const dir = await mkdtemp(join(tmpdir(), "zerolux-web-search-test-"));
  const codexHome = join(dir, "codex");
  await Bun.write(join(codexHome, "auth.json"), "{}");
  try {
    await work(
      {
        run,
        researchDir: join(dir, "research"),
        codexHome,
        now: () => new Date("2001-02-03T15:04:05.678Z"),
      },
      dir,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("claude quick mode: isolated flags, prompt on stdin, cited JSON back", async () => {
  const fake = fakeRunner(async () => ({
    stdout: claudeStream(JSON.stringify(answer)),
  }));
  await withDeps(async (deps) => {
    const outcome = await search(
      "claude",
      { ...quick, model: "sonnet", effort: "low" },
      deps,
      undefined,
    );
    expect(outcome).toEqual({
      mode: "quick",
      answer: answer.answer,
      results: answer.results.slice(0, 3),
    });
    const [call] = fake.calls;
    expect(call?.cmd).toBe("claude");
    expect(call?.args).toContain("--setting-sources");
    expect(call?.args.join(" ")).toContain("--tools WebSearch,WebFetch");
    expect(call?.args).toContain("--strict-mcp-config");
    expect(call?.args.join(" ")).toContain("--model sonnet --effort low");
    expect(call?.args).toContain("--json-schema");
    expect(call?.options.stdin).toContain(quick.query);
    expect(call?.options.cwd).not.toBe(process.cwd());
    expect(call?.options.timeoutMs).toBe(120_000);
  }, fake.run);
});

test("codex quick mode: isolated CODEX_HOME with auth and live web search, schema file, last message", async () => {
  // The workspace is gone once the search returns, so inspect it from inside the fake CLI.
  const seen: Record<string, string> = {};
  const fake = fakeRunner(async (_cmd, args, options) => {
    const flag = (name: string) => args[args.indexOf(name) + 1]!;
    await writeFile(flag("--output-last-message"), JSON.stringify(answer));
    const home = options.env.CODEX_HOME!;
    seen.home = home;
    seen.config = await readFile(join(home, "config.toml"), "utf8");
    seen.auth = await readFile(join(home, "auth.json"), "utf8");
    seen.schema = await readFile(flag("--output-schema"), "utf8");
    return {};
  });
  await withDeps(async (deps) => {
    const outcome = await search(
      "codex",
      { ...quick, model: "gpt-6-sol", effort: "high" },
      deps,
      undefined,
    );
    expect(outcome.mode).toBe("quick");
    const [call] = fake.calls;
    expect(call?.cmd).toBe("codex");
    expect(call?.args.slice(0, 2)).toEqual(["exec", "--ephemeral"]);
    expect(call?.args.join(" ")).toContain("--sandbox read-only");
    expect(call?.args.join(" ")).toContain(
      '--config model_reasoning_effort="high"',
    );
    expect(call?.args.join(" ")).toContain("--model gpt-6-sol");
    expect(seen.home).not.toBe(deps.codexHome);
    expect(seen.config).toBe('web_search = "live"\n');
    expect(seen.auth).toBe("{}");
    expect(JSON.parse(seen.schema!).required).toEqual(["answer", "results"]);
  }, fake.run);
});

test("research mode saves a Markdown report and returns its path with an abstract", async () => {
  const report =
    "# Tauri\n\nAbstract here.\n\n## Findings\n\nStable is 2.12.1 [1].\n\n## Sources\n\n1. https://crates.io/crates/tauri\n";
  const fake = fakeRunner(async () => ({
    stdout: claudeStream(report),
  }));
  await withDeps(async (deps) => {
    const outcome = await search("claude", research, deps, undefined);
    if (outcome.mode !== "research") throw new Error("expected research");
    expect(outcome.path).toBe(
      join(
        deps.researchDir,
        "2001-02-03_15-04-05_claude_latest-tauri-version.md",
      ),
    );
    expect(await readFile(outcome.path, "utf8")).toBe(report);
    expect(outcome.abstract).toBe(report.trim());
    expect(fake.calls[0]?.args).not.toContain("--json-schema");
    expect(fake.calls[0]?.options.timeoutMs).toBe(600_000);
  }, fake.run);
});

test("errors: empty query, invalid effort, CLI failure, bad JSON, empty codex message", async () => {
  const failing = fakeRunner(async () => ({ code: 1, stderr: "boom" }));
  await withDeps(async (deps) => {
    await expect(
      search("claude", { ...quick, query: " " }, deps, undefined),
    ).rejects.toThrow("empty");
    await expect(
      search("claude", { ...quick, effort: "minimal" }, deps, undefined),
    ).rejects.toThrow("not valid for claude");
    await expect(
      search("codex", { ...quick, effort: "max" }, deps, undefined),
    ).rejects.toThrow("not valid for codex");
    await expect(search("claude", quick, deps, undefined)).rejects.toThrow(
      "Claude exited with 1: boom",
    );
    await expect(search("codex", quick, deps, undefined)).rejects.toThrow(
      "Codex exited with 1: boom",
    );
  }, failing.run);
  const silent = fakeRunner(async () => ({
    stdout: claudeStream("not json"),
  }));
  await withDeps(async (deps) => {
    await expect(search("claude", quick, deps, undefined)).rejects.toThrow(
      "not valid JSON",
    );
    await expect(search("codex", quick, deps, undefined)).rejects.toThrow(
      "no final message",
    );
  }, silent.run);
  expect(() => claudeResult("nope")).toThrow("no result");
  expect(() =>
    claudeResult(
      JSON.stringify({
        type: "result",
        is_error: true,
        subtype: "error_max_turns",
      }),
    ),
  ).toThrow("error_max_turns");
  expect(() => parseQuick(JSON.stringify({ answer: 1 }), 3)).toThrow(
    "expected shape",
  );
});

test("helpers: args without optional flags, slug, report name, abstract", () => {
  expect(claudeArgs(quick)).not.toContain("--model");
  expect(codexArgs(research, { schema: "s", last: "l" })).not.toContain(
    "--output-schema",
  );
  expect(slugify("  What's a Tauri café?! ")).toBe("what-s-a-tauri-cafe");
  expect(slugify("???")).toBe("research");
  expect(
    reportName("x".repeat(100), "codex", new Date("2026-01-02T03:04:05Z")),
  ).toBe(`2026-01-02_03-04-05_codex_${"x".repeat(60)}.md`);
  expect(abstractOf("short")).toBe("short");
  expect(abstractOf("a".repeat(1000)).length).toBe(801);
});

test("the extension registers both tools, runs them with the session cwd and reports progress", async () => {
  const tools: any[] = [];
  const updates: any[] = [];
  const fake = fakeRunner(async () => ({
    stdout: claudeStream(JSON.stringify(answer)),
  }));
  await withDeps(async (deps, dir) => {
    let seen = "";
    webSearch(
      {
        registerTool: (tool: any) => tools.push(tool),
      } as unknown as ExtensionAPI,
      (cwd) => {
        seen = cwd;
        return deps;
      },
    );
    expect(tools.map((tool) => tool.name)).toEqual([
      "web_search_claude",
      "web_search_codex",
    ]);
    const result = await tools[0].execute(
      "call",
      { query: quick.query, max_results: 2, model: "sonnet", effort: "low" },
      undefined,
      (partial: unknown) => updates.push(partial),
      { cwd: dir },
    );
    expect(seen).toBe(dir);
    expect(result.details.outcome.results).toHaveLength(2);
    expect(result.details).toMatchObject({
      provider: "claude",
      mode: "quick",
      model: "sonnet",
      effort: "low",
      query: quick.query,
      steps: [{ kind: "search", text: "tauri" }],
    });
    expect(result.content[0].text).toContain(answer.answer);
    expect(fake.calls).toHaveLength(1);
    // First update: nothing yet; after the step: one search, no outcome.
    expect(updates[0].details.steps).toEqual([]);
    expect(updates.at(-1).details.steps).toEqual([
      { kind: "search", text: "tauri" },
    ]);
    expect(updates.at(-1).details.outcome).toBeUndefined();
  }, fake.run);
});

test("progress parsers read Claude's stream-json and Codex's --json web steps", () => {
  expect(
    claudeSteps(
      JSON.stringify({
        type: "assistant",
        message: {
          content: [
            { type: "text", text: "hi" },
            { type: "tool_use", name: "WebSearch", input: { query: "q1" } },
            { type: "tool_use", name: "WebFetch", input: { url: "https://x" } },
            { type: "tool_use", name: "StructuredOutput", input: {} },
          ],
        },
      }),
    ),
  ).toEqual([
    { kind: "search", text: "q1" },
    { kind: "fetch", text: "https://x" },
  ]);
  expect(claudeSteps(JSON.stringify({ type: "result" }))).toEqual([]);
  expect(claudeSteps("garbage")).toEqual([]);
  const codex = (action: unknown) =>
    JSON.stringify({
      type: "item.completed",
      item: { type: "web_search", action },
    });
  expect(codexSteps(codex({ type: "search", queries: ["a", "b"] }))).toEqual([
    { kind: "search", text: "a" },
    { kind: "search", text: "b" },
  ]);
  expect(codexSteps(codex({ type: "open_page", url: "https://y" }))).toEqual([
    { kind: "fetch", text: "https://y" },
  ]);
  expect(codexSteps(codex({ type: "other" }))).toEqual([]);
  expect(
    codexSteps(
      JSON.stringify({ type: "item.started", item: { type: "web_search" } }),
    ),
  ).toEqual([]);
});

test("the tool row shows what runs; the result shows steps while running, then answer and numbered links", () => {
  const theme = { fg: (_c: string, t: string) => t, bold: (t: string) => t };
  expect(
    formatCall(
      "codex",
      { query: "q", mode: "research", model: "gpt-6-sol", effort: "low" },
      theme,
    ),
  ).toBe("web search codex · research · gpt-6-sol · low\nq");
  expect(formatCall("claude", undefined, theme)).toBe(
    "web search claude · quick\n",
  );
  const details: Details = {
    provider: "claude",
    mode: "quick",
    query: "q",
    steps: [
      { kind: "search", text: "s1" },
      { kind: "fetch", text: "https://f" },
    ],
    elapsedMs: 2400,
  };
  const running = formatResult(
    details,
    { expanded: false, isPartial: true },
    theme,
  );
  expect(running).toContain("searching the web, 2 steps, 2s");
  expect(running).toContain("  search s1");
  expect(running).toContain("  fetch  https://f");
  const done = formatResult(
    {
      ...details,
      elapsedMs: 8000,
      outcome: { mode: "quick", answer: "A\nB", results: answer.results },
    },
    { expanded: false, isPartial: false },
    theme,
  );
  expect(done).toContain("done in 8s, 2 steps");
  expect(done).toContain("A\nB");
  expect(done).toContain(
    "  [1] tauri - crates.io https://crates.io/crates/tauri",
  );
  expect(done).toContain("  [4] Extra https://example.com");
  expect(done).not.toContain("dropped by maxResults");
  const expanded = formatResult(
    {
      ...details,
      outcome: { mode: "quick", answer: "A", results: answer.results },
    },
    { expanded: true, isPartial: false },
    theme,
  );
  expect(expanded).toContain("  search s1");
  expect(expanded).toContain("dropped by maxResults");
  const research = formatResult(
    {
      ...details,
      mode: "research",
      outcome: { mode: "research", path: "/r.md", abstract: "# T\n\nabs" },
    },
    { expanded: false, isPartial: false },
    theme,
  );
  expect(research).toContain("/r.md");
  expect(research).toContain("# T\n\nabs");
  expect(
    formatResult(undefined, { expanded: false, isPartial: true }, theme),
  ).toBe("");
});

test("spawnRunner feeds stdin, passes env and cwd, kills on timeout and abort", async () => {
  const echo = await spawnRunner(
    "sh",
    ["-c", 'cat; echo "$ZL_TEST $PWD" >&2'],
    {
      cwd: tmpdir(),
      env: { ZL_TEST: "ok" },
      stdin: "hello",
      signal: undefined,
      timeoutMs: 5000,
    },
  );
  expect(echo.code).toBe(0);
  expect(echo.stdout).toBe("hello");
  expect(echo.stderr.trim().startsWith("ok ")).toBe(true);
  const base = { cwd: tmpdir(), env: {}, stdin: "", timeoutMs: 100 };
  await expect(
    spawnRunner("sleep", ["5"], { ...base, signal: undefined }),
  ).rejects.toThrow("timed out");
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 50);
  await expect(
    spawnRunner("sleep", ["5"], {
      ...base,
      timeoutMs: 5000,
      signal: controller.signal,
    }),
  ).rejects.toThrow("cancelled");
});
