---
name: kobe
description: Use when controlling kobe tasks, parallel coding attempts, hosted agent sessions, task lifecycle, or the daemon-owned issue tracker from a shell.
---

<!-- kobe-skill-version: 11 — bump in lockstep with KOBE_SKILL_VERSION (src/lib/skill-install.ts). -->

# kobe shell control

Use `kobe api` to manage local coding tasks. Each Task owns a git Worktree,
branch, and Hosted PTY engine sessions. API automation works without an open
TUI; prompted `send`, `add`, and `fan-out` ensure the canonical engine session.

## Inside a kobe session, kobe verbs come first

Check where you are before choosing how to delegate or parallelize:

```bash
test -n "${KOBE_TASK_ID:-}"
```

When that passes, you are an engine session kobe manages — `$KOBE_TASK_ID`
is your task, `$KOBE_TAB_ID` your tab. Coordination should then go through
kobe, not around it, because work routed through `kobe api` gets what
ad-hoc subprocesses never do: its own Worktree and branch (no file
collisions with you), a sidebar row with live state the user can watch,
lifecycle tracking, and an explicit outcome contract.

- Parallel attempts of one prompt → `fan-out`, not N hand-rolled subagents.
- Delegating a scoped piece of work → `add --prompt`, not a raw `claude -p`
  child the user cannot see or manage.
- Following up on a task you started → `send`; waiting on results →
  `await`; comparing → `collect`; reporting your own verdict → `report`.
- Messaging another task's agent → `send`, and ONLY `send` — never relay
  through the user, a side file, or a generic peer channel. Sent from
  inside a kobe task, the prompt arrives prefixed `[KOBE PEER] from
  "<title>" (task <id> — load the kobe agent skill FIRST …)`, so the
  receiver knows who is talking, that this skill is required reading, and
  how to answer — peer conversations need no coordinator and no human
  relay. That prefix is the contract: do not strip it with `--plain` for
  coordination messages (`--plain` is only for a verbatim paste the
  receiver should treat as content, not conversation). Received a
  `[KOBE PEER]` message yourself? Load this skill first — required, not
  optional — then reply with the baked-in command, not by asking the user.
- `dispatch` stays the dispatcher's verb (deliver-only into an
  already-hosted session; never impersonate the user in someone else's
  terminal).

Your own engine's in-context subagents remain fine for read-only
research/exploration inside your task — the boundary is WORK: anything that
edits files, runs long, or the user should be able to see and steer belongs
in a kobe task. Do not recursively fan out from a spawned task.

When the check fails, none of this applies — use `kobe api` only if the
user asks for kobe by name.

## Discover before calling

```bash
kobe api schema
kobe api schema --verb add
kobe api schema --group create
kobe api <verb> --help
```

Do not guess flags. Commands emit one JSON object; errors use
`{"error":{"message","code",...}}` on stderr. Common rejections also carry
`hint` (what to do) and `nextCommandArgs` (argv for the same `kobe`
executable — run `kobe <args...>` verbatim to recover, e.g. `["api","list"]`
after `TASK_NOT_FOUND`). Add `--pretty` for readable output.

## Common operations

```bash
# Create one task and start its first engine turn.
kobe api add --repo "$PWD" --title "focused title" --vendor claude \
  --prompt "<complete scoped instruction>"

# Parallel attempts of the same prompt (hard cap 10; prefer 3-4).
kobe api fan-out --repo "$PWD" --count 3 --prompt "<prompt>"
kobe api fan-out --repo "$PWD" --agents claude:2,codex:1 --prompt "<prompt>"

# Follow up. Use an explicit id for unattended work; the active task can drift.
# From inside a kobe task this auto-prefixes [KOBE PEER] provenance
# (sender + reply command); --plain sends verbatim.
kobe api send --task-id <id> --prompt "<complete next turn>"

kobe api get-task --task-id <id>
kobe api collect --task-ids <id1>,<id2>,<id3> --pretty
kobe api list --pretty
```

`.running` means the task's canonical Hosted PTY engine session is alive.
`send` reuses it or auto-starts it when absent.

## Terminal panes

Split the workspace terminal the user is watching (tmux-style) or open a
separate command tab — the attached TUI performs it, so this is a no-op
headless:

```bash
# Split the focused tab; the pane runs the command via `sh -lc` and
# closes when it exits. Omit --command for an interactive shell.
kobe api pane-open --command "btop"
kobe api pane-open --direction down --command "watch -n1 git status -sb"
kobe api pane-open --placement tab --title logs --command "tail -f app.log"
```

Defaults: the caller's own task (`$KOBE_TASK_ID`, then the active task),
`--placement split`, `--direction right`. Alternate right/down to build a
grid; screen size bounds splitting — a split that would shrink any pane
below the minimum usable size (20×6 cells) falls back to a tab.
Panes land in the USER'S live workspace — open them when asked (monitors,
logs, dashboards), don't scatter panes for work `add`/`fan-out` should own.

## Lifecycle

| Verb | Purpose |
|---|---|
| `rename --task-id ID --title T` | Rename a task |
| `set-branch --task-id ID --branch B` | Rename its branch |
| `set-vendor --task-id ID --vendor V` | Change engine for the next launch |
| `set-status --task-id ID --status S` | Set lifecycle status |
| `archive --task-id ID [--archived=false]` | Archive/unarchive; stops live sessions |
| `pin --task-id ID [--pinned=false]` | Pin/unpin |
| `set-active --task-id ID` / `--none` | Change shared active task |
| `ensure-worktree --task-id ID` | Materialize without starting an engine |
| `land --task-id ID [--strategy merge\|squash] [--delete-branch] [--then-archive]` | Merge the task's branch into the base repo's current branch |
| `delete --task-id ID [--force]` | Destructive task + Worktree removal |
| `discover-adoptable --repo PATH` | Find untracked Worktrees |
| `adopt --repo PATH --worktree PATH` | Import a Worktree |

Prefer `archive` unless the user explicitly authorizes deletion.

## Issue tracker

Issues are daemon-owned, not repo files:

```bash
kobe api issue-list --repo "$PWD" --pretty
kobe api issue-create --repo "$PWD" --title "title" --body "context"
kobe api issue-set-status --repo "$PWD" --id <n> --status done
kobe api issue-update --repo "$PWD" --id <n> --title "new" --body "body"
kobe api issue-update --repo "$PWD" --id <n> --task <taskId>   # link; `--task none` unlinks
```

### Kanban semantics

The TUI and web render issues as a Backlog / In progress / Done board whose
columns derive from the issue's own lifecycle — do NOT move cards with
`issue-set-status doing`:

- **In progress** = the issue has a linked task; `issue-update --task <taskId>`
  IS the move (typical flow: `issue-create` → `add` a task → link them).
- **Done** = `status done`; the daemon mirrors it automatically when the
  linked task finishes.
- **Backlog** = everything else (`open`/`doing`/`hold`, unlinked).

## Fan-out rules

Fan out only when the user requests parallel approaches, comparison, or an
explicit count. Give each task a scoped prompt, report returned IDs, then use
`collect` to compare. Do not recursively fan out from spawned tasks. Do not
poll `send` in a tight loop or use it as casual chat; every call is a full
engine turn.

### Supervising a round (report / await)

Outcomes are explicit, never inferred. The contract has two sides:

**Worker side** — every fan-out prompt should end with an instruction like:
"when finished, run `kobe api report --outcome succeeded --summary '<one
line>'` (or `--outcome failed`)". Inside a task the target resolves
automatically ($KOBE_TASK_ID, else the cwd's worktree); pass `--task-id`
only from outside. The verdict is stored verbatim on the task as
`workerReport` — it is the worker's claim, not kobe-verified, so verify the
winner's actual diff before landing.

**Coordinator side** — block until the round settles instead of polling:

```bash
kobe api await --task-ids <id1>,<id2>,<id3> --timeout-secs 900
```

Returns every task's outcome as JSON once all have reported. A timeout
(`"timedOut": true`, exit 0) is a CHECKPOINT, not a failure: silence never
proves a worker died — it may be mid-turn or waiting on a permission prompt.
On timeout, inspect (`collect`, `get-task`), nudge (`send`), or simply
`await` again. Never mark an unreported task failed just because it is
silent, and never auto-retry it.

### Closing a round

After comparing attempts, finish the round instead of leaving tasks behind:

```bash
# Land the winner: merge its branch into the base repo's CURRENT branch.
# Verify the base checkout is on the intended branch first.
kobe api land --task-id <winner> --then-archive

# Archive the losers (non-destructive; branches survive).
kobe api archive --task-id <loser1>
kobe api archive --task-id <loser2>
```

`land` refuses a dirty base checkout; on merge conflict it aborts cleanly and
returns the conflicted files for manual resolution. Only `delete` destroys a
Worktree — never use it on a loser without explicit user authorization.
