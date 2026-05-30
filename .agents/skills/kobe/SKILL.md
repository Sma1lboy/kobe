---
name: kobe
description: Spawn and coordinate parallel coding tasks via the kobe TUI from your shell. Use when the user asks to "try N approaches in parallel", "fan out", "compare implementations side-by-side", or "split this into subtasks". One task per attempt, each gets its own git worktree and its own agent session.
---

# kobe — parallel coding tasks from your shell

kobe is a local terminal UI that runs many AI coding sessions at once.
Each task lives in its own git worktree with its own agent session,
running inside a tmux session. When the user asks for parallel
exploration, fan out by spawning kobe tasks instead of doing N attempts
sequentially in one chat.

## Install (prereq)

This skill teaches Claude Code when to call the `kobe` binary's CLI
verbs. The binary itself is a separate install:

```bash
npm i -g @sma1lboy/kobe       # or bun / pnpm / yarn add -g
```

Without the binary on `$PATH`, the commands below fail with
`command not found`. This skill targets kobe's `main` branch — pair it
with the latest `@sma1lboy/kobe` from npm so the `kobe api ...` verbs and
their flags stay in sync.

`kobe api ...` auto-starts the daemon if it is not already running, so
there is nothing to launch first.

## Triggers — fire fan-out when the user says

- "try N approaches in parallel", "并行试 N 个"
- "fan out", "split this into subtasks"
- "compare X and Y side-by-side"
- "explore a few different ways to..."
- explicit count: "spin up 3 tasks for..."

Single ambiguous tasks → no fan-out. Just do them in your own chat.

## How — the six verbs

Each verb is a one-shot shell command. Reads stdin: none. Writes a JSON
object to stdout, exits 0. On error, writes
`{"error":{"message":"...","code":"..."}}` to stderr and exits non-zero.

```bash
# Spawn ONE task. With --prompt, kobe also starts the task's engine
# (claude/codex/copilot) in tmux and delivers the prompt. Returns task JSON;
# read `.taskId`. `.engineReady` is false if a freshly-started engine didn't
# confirm it was ready before the prompt was pasted (delivery is best-effort).
kobe api spawn-task --repo $PWD --prompt "<scoped prompt>" [--title T] [--base-branch B] [--vendor claude|codex|copilot]

# Fan out N tasks of the same prompt in one call (the usual parallel-attempts
# entry point). Either a flat count of one vendor, or per-engine counts.
# Returns { count, tasks: [{ taskId, vendor, engineReady, ... }] }. Capped at 10.
kobe api fan-out --repo $PWD --prompt "<prompt>" --count 3
kobe api fan-out --repo $PWD --prompt "<prompt>" --agents claude:2,codex:1

# Send a follow-up prompt to a task's running engine. Prefer --task-id for
# unattended fan-out: the bare default targets the *active* task (whatever the
# TUI last focused), which can drift under you.
kobe api send [--task-id <id>] --prompt "<text>"

# Read a task's metadata. `.running` is true when its tmux session is live.
kobe api get-task --task-id <id>

# Aggregation snapshot for comparing attempts: per task, identity + branch +
# `.running` + uncommitted `.changes` ({added, deleted} file counts). Read-only.
kobe api collect --task-ids <id1>,<id2>,<id3>
kobe api collect --repo $PWD            # all non-archived tasks in the repo

# List all tasks.
kobe api list
```

Add `--pretty` to any verb to pretty-print stdout for inspection.
Output to stdout is always one JSON object terminated with `\n`.

> v0.6 is tmux-native: a task's chat history lives in its tmux session,
> not in the daemon. So `send` injects the prompt into the engine pane
> (like typing it), and there is no CLI verb that reads the engine's
> reply back — the user reviews results in the kobe TUI. There are no
> `create-tab` / `get-tab` verbs; extra chat tabs are tmux windows you
> open from inside the TUI.

## Workflow — fan-out + compare + hand off to the TUI

```bash
# 1. Fan out 3 parallel attempts in one call. (For distinct per-attempt
#    prompts, use separate spawn-task calls instead; fan-out shares one prompt.)
IDS=$(kobe api fan-out --repo "$PWD" --count 3 \
  --prompt "Make the sidebar virtualize long task lists. Explore your own approach." \
  | jq -r '.tasks[].taskId')

# 2. Tell the user what you spawned so the sidebar reads back correctly,
#    and point them at the TUI to watch each agent work.
echo "Spawned: $IDS — open the kobe TUI to watch them."

# 3. Once they've run, compare attempts (branch + uncommitted change counts).
kobe api collect --task-ids "$(echo "$IDS" | paste -sd, -)" --pretty
```

To drive an already-running task further, `send` a follow-up:

```bash
kobe api send --task-id "<id>" --prompt "Now add tests for the edge cases."
```

## Do

- Keep fan-out to 3-4 in practice (one `--count 3` is plenty); `fan-out` hard-caps a single call at 10.
- Give each subtask its own scoped prompt — don't dump the whole parent conversation.
- Tell the user what was spawned, with IDs, so they can follow along in the sidebar / TUI.
- Aggregate or compare results back into your own chat once the user reports what each task produced.

## Don't

- Don't fan out for single simple tasks. One thing → do it yourself in chat.
- Don't recursively spawn from inside a spawned task. There is no recursion
  guard yet; you will starve the concurrency cap and the inner spawn will hang.
- Don't use `kobe api send` as a chat channel. Every send is a full agent
  turn — it costs tokens and time. Send a complete instruction, not a conversation.
- Don't poll `send` in a tight loop. There is no CLI signal for "the turn
  finished" in v0.6 — the user watches progress in the TUI.
- Don't delete tasks. There is no `kobe api delete` verb on purpose. Cleanup
  happens in the TUI by the user.
