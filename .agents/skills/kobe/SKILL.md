---
name: kobe
description: Use when controlling kobe tasks, parallel coding attempts, hosted agent sessions, task lifecycle, or the daemon-owned issue tracker from a shell.
---

<!-- kobe-skill-version: 7 — bump in lockstep with KOBE_SKILL_VERSION (src/lib/skill-install.ts). -->

# kobe shell control

Use `kobe api` to manage local coding tasks. Each Task owns a git Worktree,
branch, and Hosted PTY engine sessions. API automation works without an open
TUI; prompted `send`, `add`, and `fan-out` ensure the canonical engine session.

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
kobe api send --task-id <id> --prompt "<complete next turn>"

kobe api get-task --task-id <id>
kobe api collect --task-ids <id1>,<id2>,<id3> --pretty
kobe api list --pretty
```

`.running` means the task's canonical Hosted PTY engine session is alive.
`send` reuses it or auto-starts it when absent.

## Directed task delegation

The TUI's `prefix+@` links the focused Task (the **primary**) to one existing
Task (the **subagent**). This is a directed relationship, not a shared chat:
neither native session is forked, no Channel transcript is created, and the
primary remains responsible for the user-facing result.

The bootstrap turn supplies literal primary/subagent task ids. Use those ids
on every call; never rely on the globally active Task for delegation traffic.

```bash
kobe api send --task-id <subagent-task-id> --prompt "<one complete scoped request>"
kobe api send --task-id <primary-task-id> --prompt "<one structured result>"
```

Every delegated request must carry enough context to execute independently:

```text
[KOBE DELEGATION REQUEST v1]
primary_task_id: <id>
subagent_task_id: <id>
objective: <one bounded outcome>
constraints: <scope, files, permissions, forbidden actions>
done_when: <observable acceptance evidence>
reply_via: kobe api send --task-id <primary-id> --prompt "<structured result>"
```

Protocol rules:

- One `send` is one full engine turn. Batch useful information; no greetings,
  polling, acknowledgement-only messages, or unbounded ping-pong.
- Do not recursively delegate unless the user explicitly asks. The primary
  may own multiple subagents, but a subagent has one direct primary.
- Stay inside your own Task/worktree. Send findings or patches by reference;
  never edit the other Task's worktree directly.
- Delegation grants no authority to delete, commit, push, open/merge a PR, or
  widen scope. Normal user-authorization rules still apply independently.
- A subagent response is an evidence-bearing claim. The primary verifies it
  before integration and owns the final answer.
- On completion, reply once with status, summary, evidence/artifacts, and any
  blockers or remaining risks. Use `kobe api report` only when the surrounding
  workflow also needs the durable worker-outcome/`await` mechanism.

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
