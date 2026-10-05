# Agents and tasks

ZeroLux uses the harnesses you already have: pi, Claude Code and Codex.

## Check the harnesses

```sh
cargo run -- doctor
```

It prints the installed `pi`, `claude` and `codex` versions. It starts nothing.

## Hire agents

On first open, enter your name. Then hire agents from Team > Hire: pick a running session, as a new agent or as another session of an existing one. Each agent has its own ID and you as owner. Several agents can use the same harness.

## Run a task

Create a task, assign it to an agent and queue it. A worker then runs it in a directory you choose:

```sh
cargo run -- worker --project PROJECT_ID --actor ACTOR_ID \
  --workspace /absolute/path/to/worktree --harness pi|claude-code|codex
```

| Harness     | Command, followed by the task prompt                            |
| ----------- | --------------------------------------------------------------- |
| pi          | `pi --print --`                                                 |
| Claude Code | `claude --print --permission-prompts none --output-format text` |
| Codex       | `codex exec --color never`                                      |

Instead of `--harness`, put any command after `--`; the prompt is added as its last argument. The worker runs one task and exits; `--watch` keeps taking queued tasks. The default timeout is 30 minutes (`--timeout-secs`).

The result goes to review. Approve it, or request changes with a note and the task is queued again.

## pi in an open session

The pi extension (`.pi/extensions/zerolux.ts`) works inside a pi session that is already open:

```text
/reload
/zerolux connect PROJECT_ID PI_ACTOR_ID
/zerolux take
/zerolux disconnect
```

`take` asks for confirmation, runs one queued task in the current conversation and sends back only the final answer.

This repository sets `steeringMode: "all"` in `.pi/settings.json`, so pi reads all waiting chat messages in one step.
