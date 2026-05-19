---
name: kobe
description: Spawn and coordinate parallel coding tasks via the kobe TUI from your shell. Use when the user asks to "try N approaches in parallel", "fan out", "compare implementations side-by-side", or "split this into subtasks". One task per attempt, each gets its own git worktree and its own agent session.
---

# kobe — parallel coding tasks from your shell

kobe is a local terminal UI that runs many AI coding sessions at once.
Each task lives in its own git worktree with its own agent session.
When the user asks for parallel exploration, fan out by spawning kobe
tasks instead of doing N attempts sequentially in one chat.

## Install (prereq)

This skill teaches Claude Code when to call the `kobe` binary's CLI
verbs. The binary itself is a separate install:

```bash
npm i -g @sma1lboy/kobe       # or bun / pnpm / yarn add -g
```

Without the binary on `$PATH`, the commands below fail with
`command not found`. This skill targets kobe's `main` branch — pair it
with the latest `@sma1lboy/kobe` from npm so the `kobe api ...` verbs
and their flags stay in sync.

The daemon must already be running. The TUI auto-starts it; if not, run
`kobe daemon start` once.

## Triggers — fire fan-out when the user says

- "try N approaches in parallel", "并行试 N 个"
- "fan out", "split this into subtasks"
- "compare X and Y side-by-side"
- "explore a few different ways to..."
- explicit count: "spin up 3 tasks for..."

Single ambiguous tasks → no fan-out. Just do them in your own chat.

## How — the five verbs

Each verb is a one-shot shell command. Reads stdin: none. Writes a JSON
object to stdout, exits 0. On error, writes
`{"error":{"message":"...","code":"..."}}` to stderr and exits non-zero.

```bash
# Spawn a new task. Returns task JSON; read `.taskId`.
kobe api spawn-task --repo $PWD --prompt "<scoped prompt>" [--title T] [--base-branch B]

# Create an extra chat tab on an existing task.
kobe api create-tab --task-id <id> [--title T]

# Send a follow-up prompt to a task (resumes the agent session).
kobe api send --task-id <id> --prompt "<text>" [--tab-id TID]

# Read a task's current state (status, branch, worktree, tabs).
kobe api get-task --task-id <id>

# Read a single tab off a task.
kobe api get-tab --task-id <id> --tab-id <tab-id>
```

Add `--pretty` to any verb to pretty-print stdout for inspection.
Output to stdout is always one JSON object terminated with `\n`.

## Workflow — fan-out + report back

```bash
# 1. Spawn 3 parallel attempts. Cap at 3-4.
T1=$(kobe api spawn-task --repo "$PWD" --prompt "Approach A: use a state machine" | jq -r .taskId)
T2=$(kobe api spawn-task --repo "$PWD" --prompt "Approach B: use event sourcing"    | jq -r .taskId)
T3=$(kobe api spawn-task --repo "$PWD" --prompt "Approach C: use a reducer pattern" | jq -r .taskId)

# 2. Tell the user what you spawned so the sidebar reads back correctly.
echo "Spawned three tasks: $T1 (state machine), $T2 (event sourcing), $T3 (reducer)"

# 3. Poll until each is idle. Don't tight-loop; sleep 5-15s between checks.
for ID in $T1 $T2 $T3; do
  while true; do
    STATUS=$(kobe api get-task --task-id "$ID" | jq -r .task.status)
    case "$STATUS" in
      idle|awaiting-approval|done) break ;;
    esac
    sleep 10
  done
done

# 4. Read each result and aggregate. The active tab's id is on the task.
for ID in $T1 $T2 $T3; do
  TAB=$(kobe api get-task --task-id "$ID" | jq -r .task.activeTabId)
  kobe api get-tab --task-id "$ID" --tab-id "$TAB"
done
```

## Do

- Cap fan-out at 3-4 in parallel. The orchestrator caps total concurrency at 4.
- Give each subtask its own scoped prompt — don't dump the whole parent conversation.
- Tell the user what was spawned, with IDs, so they can follow along in the sidebar.
- Poll status with `sleep` between calls. 5-15 seconds is fine.
- Aggregate results back into your own chat before reporting to the user.

## Don't

- Don't fan out for single simple tasks. One thing → do it yourself in chat.
- Don't recursively spawn from inside a spawned task. There is no recursion
  guard yet; you will starve the concurrency cap and the inner spawn will
  hang.
- Don't use `kobe api send` as a chat channel. Every send is a full agent
  turn — it costs tokens and time. Send a complete instruction, not a
  conversation.
- Don't delete tasks. There is no `kobe api delete` verb on purpose. Cleanup
  happens in the TUI by the user.

## When the daemon is not running

`kobe api ...` exits 2 with `{"error":{"code":"BAD_DAEMON",...}}` on stderr.
If you see this:

> The kobe daemon is not running. Ask the user to run `kobe daemon start`
> (or launch the kobe TUI, which auto-starts it), then re-try.

Don't try to start the daemon yourself; that's the user's call.
