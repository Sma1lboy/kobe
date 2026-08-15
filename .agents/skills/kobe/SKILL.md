---
name: rove
description: Use when controlling Rove tasks, parallel coding attempts, hosted agent sessions, task lifecycle, or the daemon-owned issue tracker from a shell. Also the ONLY channel for messaging another agent session on this machine — `rove api send`, never a peer/MCP side channel.
---

<!-- rove-skill-version: 23 — bump in lockstep with KOBE_SKILL_VERSION (src/lib/skill-install.ts). -->

# Rove shell control

Use `rove api` to manage local coding tasks. Managed Tasks created by API
automation own a git Worktree and branch plus Hosted PTY engine tabs; project
main and directory Tasks reuse existing directories. API automation works
without an open TUI; prompted `send`, `add`, and `fan-out` ensure a target
engine tab.

## Inside a Rove session, Rove verbs come first

Check where you are before choosing how to delegate or parallelize:

```bash
test -n "${ROVE_TASK_ID:-}"
```

When that passes, you are an engine session Rove manages — `$ROVE_TASK_ID`
is your task, `$ROVE_TAB_ID` your tab. Coordination should then go through
Rove, not around it, because work routed through `rove api` gets what
ad-hoc subprocesses never do: its own Worktree and branch (no file
collisions with you), a sidebar row with live state the user can watch,
lifecycle tracking, and an explicit outcome contract.

- Parallel attempts of one prompt → `fan-out`, not N hand-rolled subagents.
- Delegating a scoped piece of work → `add --prompt`, not a raw `claude -p`
  child the user cannot see or manage.
- Following up on a task you started → `send`; comparing → `collect`;
  finished your own task and were spawned by another → a bare `send`
  (no `--task-id`) replies to the DISPATCHER — the exact task + tab that
  created you, recorded at creation (`.task.dispatcher` on `get-task`).
  If that tab died it falls back to the dispatcher task's live canonical
  engine tab; nothing alive fails loud (`DISPATCHER_UNREACHABLE`) — it
  never spawns a new engine, so a failed reply is visible, not fake-ok.
- Messaging another agent session on this machine → `send`, and ONLY `send`
  — never relay through the user, a side file, or a generic peer channel
  (an MCP server offering to message "other instances" is exactly that
  channel: it reaches a process, not a task, so nothing it delivers is
  attributable, watchable, or replyable). Sent from
  inside a Rove task, the prompt arrives prefixed `[KOBE PEER] from
  "<title>" (task <id> — load the Rove agent skill FIRST …)`, so the
  receiver knows who is talking, that this skill is required reading, and
  how to answer — the baked-in reply command is tab-precise
  (`--task-id <sender> --tab <sender's tab>`), so peer conversations need
  no coordinator and no human relay. That prefix is the contract: do not
  strip it with `--plain` for
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
in a Rove task. Do not recursively fan out from a spawned task.

When the check fails, none of this applies — use `rove api` only if the
user asks for Rove by name.

## Vocabulary — what the user's words map to

| Term | What it is | Isolation it gives | Users also say |
|---|---|---|---|
| **Task** | one tracked workspace record — managed worktree, saved-project main, or existing directory | managed Tasks own files + branch; main/directory Tasks reuse files | "a task", "a new one", "a separate attempt" |
| **Worktree** | the isolated git working tree a managed Task owns (`.task.worktreePath`) | — | "workspace", "this checkout", "this branch", "here" |
| **Terminal Tab** | one engine, shell, command, or content surface inside a Task | an engine tab has its own conversation, but every tab uses the SAME Task files | "tab", "chattab", "another chat", "a second agent on this" |
| **Split** | the tree that divides ONE Terminal Tab into several regions (the `pane-open` verb's unit; a leaf is not called a pane) | none — same session's screen, same files | "split it", "side by side", "put the logs next to it" |

Two of those colloquialisms are traps, so read them as INTENT, not as
product terms: in Rove's own vocabulary **Workspace** is the center Terminal
Tab region of the UI (CONTEXT.md), not a checkout, and **ChatTab** is
retired vocabulary for Terminal Tab. A user saying "in this workspace" means
the worktree they are looking at — answer the intent, keep writing the real
term.

They nest — **Task ⊃ Terminal Tab ⊃ Split** — and isolation drops at every
level down:

```text
new Task   → own worktree + own branch     (parallel work can't collide)
new Tab    → own engine session, SAME files (a helper in the same checkout)
new Split  → same session's screen, one tab divided (a monitor beside the work)
```

The distinction that decides every routing call: **a new tab shares the
worktree and branch; only a new task gets its own.** Two tabs in one task
edit the same files, so they can collide — that is a feature when the user
wants a helper in the same checkout, and a bug when they wanted parallel
attempts. A split isolates nothing at all: it is a layout, for watching
something (logs, `btop`, a test loop) next to the work — never the answer to
"do this work".

### Where does this work land?

Inside a Rove session (`$ROVE_TASK_ID` non-empty — check first: it is what
makes the tab/split rows addressable at all), match top to bottom and take
the first row that fits:

| The user says | Lands in | Command |
|---|---|---|
| "you do it", "just fix it", "change X to Y" | you, right here | no Rove verb — edit the files yourself |
| "try it N ways", "compare approaches" | N new tasks | `rove api fan-out --repo "$PWD" --count N --prompt "…"` |
| "split", "side by side", "keep an eye on X while…" | a new region in the CURRENT tab | `rove api pane-open --command "…"` |
| names a tab: "tell the agent in tab 3" | that exact tab | `rove api send --task-id <id> --tab tab-3 --prompt "…"` |
| a LOCATION word: "in this workspace/worktree/checkout", "on this branch", "here", "same task" | THIS task, a NEW Terminal Tab | `rove api send --task-id "$ROVE_TASK_ID" --tab new --prompt "…"` |
| names an ENGINE for the same files: "let codex take over here", "try this one with claude instead" | THIS task, a new tab pinned to that engine | `rove api send --task-id "$ROVE_TASK_ID" --tab new --vendor codex --prompt "…"` |
| **anything else — no row above matched** | a NEW task — new worktree + branch | `rove api add --repo "$PWD" --prompt "…"` |

Order is the tiebreak: a count ("3 ways in this workspace") beats a location
word, and delegation language loses to "you do it" — the user asking YOU is
not asking for a fleet. Two more rules the table can't show:

- No location word at all ⇒ new task. It is the only routing whose isolation
  cannot corrupt work-in-progress, so it is the safe default.
- "this repo" / "this project" are NOT location words — they name the repo,
  not the checkout. Only worktree-scoped words route to a tab.

Outside a Rove session none of this applies: there is no "this task" to add
a tab to, so `add` / `fan-out` are the only routings available.

### Know where you are before you route

```bash
echo "$ROVE_TASK_ID / $ROVE_TAB_ID"          # who you are (empty = not a Rove session)
rove api get-task --task-id "$ROVE_TASK_ID"  # .task.worktreePath, .task.branch, .running, .tabs[]
```

`get-task` is the per-task read that answers "what is my worktree, my
branch, and which sibling tabs exist" — `.tabs[]` carries each tab's `id`, `kind`,
`vendor`, `lastTitle` and `alive`, which is exactly the target list for
`send --tab`. A tab flagged `unregistered: true` is a live session the tab
snapshot lost; it is addressable like any other.

## Discover before calling

```bash
rove api schema
rove api schema --verb add
rove api schema --group create
rove api <verb> --help
```

Do not guess flags. Commands emit one JSON object; errors use
`{"error":{"message","code",...}}` on stderr. Common rejections also carry
`hint` (what to do) and `nextCommandArgs` (argv for the same `Rove`
executable — run `rove <args...>` verbatim to recover, e.g. `["api","list"]`
after `TASK_NOT_FOUND`). Add `--pretty` for readable output.

## Common operations

```bash
# Create one task and start its first engine turn.
rove api add --repo "$PWD" --title "focused title" --vendor claude \
  --prompt "<complete scoped instruction>"

# Parallel attempts of the same prompt (hard cap 10; prefer 3-4).
rove api fan-out --repo "$PWD" --count 3 --prompt "<prompt>"
rove api fan-out --repo "$PWD" --agents claude:2,codex:1 --prompt "<prompt>"

# Follow up. Use an explicit id for unattended work; the active task can drift.
# From inside a Rove task this auto-prefixes [KOBE PEER] provenance
# (sender + reply command); --plain sends verbatim.
rove api send --task-id <id> --prompt "<complete next turn>"

# Reply home: no --task-id inside a dispatched task = the dispatcher's tab.
rove api send --prompt "succeeded: <one line> (branch <final branch>)"

# A task can hold several Terminal Tabs. `get-task` lists ONE task's tabs (the
# usual read before addressing one); `inspect` is the wider diagnostic — every
# task's snapshot plus daemon activity and live pty sessions.
rove api inspect --task-id <id>
rove api send --task-id <id> --tab tab-3 --prompt "<turn>"  # exact alive tab
rove api send --task-id <id> --tab new --prompt "<turn>"    # fresh engine tab
# Same worktree, DIFFERENT agent — the API twin of the TUI's ctrl+e pick. The
# engine is pinned to that tab (survives restarts, unaffected by a later
# set-vendor) and the task's own vendor is left alone. --tab new only.
rove api send --task-id <id> --tab new --vendor codex --prompt "<turn>"

rove api get-task --task-id <id>
rove api collect --task-ids <id1>,<id2>,<id3> --pretty
rove api list --pretty
```

`.running` means any hosted engine tab on the task is alive; a live shell,
command, or content tab alone does not count.
Omitting BOTH `--task-id` and `--tab` inside a task that has a dispatcher
targets that dispatcher's tab (see the reply rule above); otherwise the
target is the active task. Omitting only `--tab` targets a live engine tab
(`tab-1` first, then any surviving engine tab). Only when the task has NO live session at all does `send`
auto-start the canonical engine in the task's worktree (`started: true` in
the result marks that fresh session). If live tabs exist but none resolves
as an engine, it refuses with `NO_ENGINE_TAB` — address one with `--tab
tab-N` or spawn one with `--tab new`; it never silently spawns a duplicate
engine.

## Terminal panes

Split the workspace terminal the user is watching (tmux-style) or open a
separate command tab — the attached TUI performs it, so this is a no-op
headless:

```bash
# Split the focused tab; the pane runs the command via `sh -lc` and
# closes when it exits. Omit --command for an interactive shell.
rove api pane-open --command "btop"
rove api pane-open --direction down --command "watch -n1 git status -sb"
rove api pane-open --placement tab --title logs --command "tail -f app.log"

# Close panes you opened, by their --title (engine panes are never closed).
rove api pane-close --title logs

# Toast a one-liner in every attached Rove UI — surface "done / needs input /
# error" moments without touching any session (kinds get severity styling).
rove api notify --title "build green, artifacts in dist/" --kind done
```

Defaults: the caller's own task (`$ROVE_TASK_ID`, then the active task),
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
| `land --task-id ID [--strategy merge\|squash] [--delete-branch] [--then-archive] [--remove-worktree]` | Merge the task's branch into the base repo's current branch; `--remove-worktree` cleans up the Worktree after (branch stays; dirty/self/base refused, outcome in the result's `worktree` field) |
| `delete --task-id ID [--force]` | Destructive task + Worktree removal |
| `discover-adoptable --repo PATH` | Find untracked Worktrees |
| `adopt --repo PATH --worktree PATH` | Import a Worktree |

Prefer `archive` unless the user explicitly authorizes deletion.

## Issue tracker

Issues are daemon-owned, not repo files:

```bash
rove api issue-list --repo "$PWD" --pretty
rove api issue-create --repo "$PWD" --title "title" --body "context"
rove api issue-set-status --repo "$PWD" --id <n> --status done
rove api issue-update --repo "$PWD" --id <n> --title "new" --body "body"
rove api issue-update --repo "$PWD" --id <n> --task <taskId>   # link; `--task none` unlinks
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

### Completion flows back through an engine tab (`send`)

Outcomes are explicit, never inferred — and they travel as a MESSAGE to the
spawning agent's engine tab, not as stored state nobody reads.

**Worker side** — a task created from inside another Rove task records its
dispatcher (the creating task + tab); when the work is finished, a bare
`rove api send --prompt "<succeeded|failed>: <one line> (branch <final
branch>)"` routes the outcome back to that exact tab. Include the final
branch name — the spawner needs it to `land`. The first-prompt coda still
names the spawner for an explicit `--task-id` send.

**Coordinator side** — do NOT block or poll. Keep working (or end your
turn); each worker's outcome arrives in your chat as a `[KOBE PEER]` message
with its task id. What arrives is the worker's claim, not Rove-verified —
verify the winner's actual diff before landing. Silence never proves a
worker died (it may be mid-turn or stuck on a permission prompt): peek with
`collect`/`get-task`, nudge with `send`, and never mark a silent task failed
or auto-retry it.

### Closing a round

After comparing attempts, finish the round instead of leaving tasks behind:

```bash
# Land the winner: merge its branch into the base repo's CURRENT branch.
# Verify the base checkout is on the intended branch first.
rove api land --task-id <winner> --then-archive

# Archive the losers (non-destructive; branches survive).
rove api archive --task-id <loser1>
rove api archive --task-id <loser2>
```

`land` refuses a dirty base checkout; on merge conflict it aborts cleanly and
returns the conflicted files for manual resolution. Only `delete` destroys a
Worktree — never use it on a loser without explicit user authorization.
