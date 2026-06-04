---
name: kobe
description: Drive kobe — a local TUI that runs many parallel AI coding sessions — from your shell via `kobe api`. Use to spawn/fan-out parallel attempts, AND to manage the full task lifecycle (create, rename, re-branch, archive, delete, pin, switch focus) without leaving the terminal. Each task is its own git worktree + agent session. Run `kobe api schema` to discover the whole surface.
---

<!-- kobe-skill-version: 1 — bump in lockstep with KOBE_SKILL_VERSION (src/lib/skill-install.ts) whenever this file's guidance changes; that's how `kobe` detects an out-of-date installed skill and prompts `kobe skill install`. -->

# kobe — parallel coding tasks + full task control from your shell

kobe is a local terminal UI that runs many AI coding sessions at once.
Each task lives in its own git worktree with its own agent session inside
a tmux session. `kobe api` is the scriptable control surface: fan out
parallel attempts, AND manage the whole task lifecycle — more than the TUI
exposes — as one-shot JSON commands.

## Install

This skill is installed via the agent-skills CLI. The easiest path is the
kobe wrapper, which runs `npx skills add Sma1lboy/kobe` for you:

```bash
npm i -g @sma1lboy/kobe        # the binary (or bun / pnpm / yarn add -g)
kobe skill install            # wraps `npx skills add Sma1lboy/kobe --skill kobe`
```

`kobe api ...` auto-starts the daemon if it isn't running — nothing to
launch first. Re-run `kobe skill install` after a `kobe` upgrade to pull
the matching skill.

## Explore the surface — LEVELED (don't slurp it all)

The API is self-documenting, but explore it in levels so you don't flood
your context with every flag of every verb:

```bash
kobe api schema                 # COMPACT index: groups + verb summaries (no flags)
kobe api schema --verb add      # drill into ONE verb's full flag detail
kobe api schema --group create  # just the verbs in one group
kobe api <verb> --help          # human-readable usage for one verb
kobe api schema --all           # the WHOLE spec — large, use only if a tool needs it
```

Start with `kobe api schema` (small), then `--verb <name>` for the one you
need. Read it instead of guessing flags. Every verb writes one JSON object
to stdout (exit 0); errors are `{"error":{"message","code"}}` on stderr
(exit ≠ 0). Add `--pretty` to any verb to indent stdout.

## Triggers — fire fan-out when the user says

- "try N approaches in parallel", "并行试 N 个"
- "fan out", "split this into subtasks"
- "compare X and Y side-by-side"
- "explore a few different ways to..."
- explicit count: "spin up 3 tasks for..."

Single ambiguous tasks → no fan-out. Just do them in your own chat.

## Core verbs

```bash
# Create a task — shows in the sidebar IMMEDIATELY (backlog). Fully
# parameterized: title, explicit branch, base branch, vendor, status, pin.
# With --prompt it also materializes the worktree, starts the engine, and
# delivers the first message. Returns task JSON; read `.taskId`.
kobe api add --repo "$PWD" --title "virtualize sidebar" \
  --vendor claude --pin --prompt "<scoped prompt>"
# (`spawn-task` is a back-compat alias of `add`.)

# Fan out N tasks of ONE prompt (the usual parallel-attempts entry point).
# Flat count of one vendor, or per-vendor counts. Capped at 10.
kobe api fan-out --repo "$PWD" --prompt "<prompt>" --count 3
kobe api fan-out --repo "$PWD" --prompt "<prompt>" --agents claude:2,codex:1

# Send a follow-up into a task's running engine (one full turn). Prefer
# --task-id for unattended fan-out; the bare default targets the *active*
# task, which can drift.
kobe api send --task-id <id> --prompt "<text>"

# Read one task. `.running` = its tmux session is live.
kobe api get-task --task-id <id>

# Compare attempts: per task → identity, branch, .running, uncommitted
# .changes ({added, deleted}). Read-only.
kobe api collect --task-ids <id1>,<id2>,<id3>
kobe api collect --repo "$PWD"            # all non-archived tasks in the repo

# List every task.
kobe api list
```

## Full task lifecycle (more than the TUI)

All one-shot; see `kobe api <verb> --help` for flags.

| Verb | What it does |
|---|---|
| `rename --task-id ID --title T` | Set the task title |
| `set-branch --task-id ID --branch B` | Rename the branch (git branch -m if materialized) |
| `set-vendor --task-id ID --vendor V` | Change engine vendor (takes effect on next rebuild) |
| `set-status --task-id ID --status S` | Set lifecycle status (backlog/in_progress/in_review/done/canceled/error) |
| `archive --task-id ID [--archived=false]` | Archive / unarchive (non-destructive) |
| `pin --task-id ID [--pinned=false]` | Pin / unpin to the top of the sidebar |
| `set-active --task-id ID` / `--none` | Set the shared active-task focus every pane highlights |
| `ensure-worktree --task-id ID` | Materialize the worktree on disk (no engine) |
| `delete --task-id ID [--force]` | **Destructive** — remove the task + worktree (prefer archive) |
| `discover-adoptable --repo PATH` | List untracked git worktrees in a repo |
| `adopt --repo PATH --worktree PATH` | Import an existing worktree as a task |

## Workflow — fan-out + compare

```bash
# 1. Fan out 3 parallel attempts. (For distinct per-attempt prompts, use
#    separate `add` calls; fan-out shares one prompt.)
IDS=$(kobe api fan-out --repo "$PWD" --count 3 \
  --prompt "Make the sidebar virtualize long task lists. Explore your own approach." \
  | jq -r '.tasks[].taskId')

# 2. Tell the user what you spawned and point them at the kobe TUI to watch.
echo "Spawned: $IDS — open the kobe TUI to watch them."

# 3. Once they've run, compare attempts (branch + uncommitted change counts).
kobe api collect --task-ids "$(echo "$IDS" | paste -sd, -)" --pretty
```

> tmux-native: a task's chat history lives in its tmux session, not the
> daemon. `send` injects a prompt into the engine pane (like typing it);
> there is no verb that reads the engine's reply back — the user reviews
> results in the TUI.

## Do

- Explore with `kobe api schema` before composing a call — don't guess flags.
- Keep fan-out to 3-4 in practice; `fan-out` hard-caps a single call at 10.
- Give each subtask its own scoped prompt — don't dump the whole parent conversation.
- Tell the user what was spawned, with IDs, so they can follow along in the sidebar.
- Prefer `archive` over `delete` — archiving keeps the worktree, branch, and history.

## Don't

- Don't fan out for single simple tasks. One thing → do it yourself in chat.
- Don't recursively spawn from inside a spawned task. There is no recursion
  guard yet; you will starve the concurrency cap and the inner spawn will hang.
- Don't use `send` as a chat channel. Every send is a full agent turn — it
  costs tokens and time. Send a complete instruction, not a conversation.
- Don't poll `send` in a tight loop. There is no CLI "turn finished" signal —
  the user watches progress in the TUI.
- Don't `delete` to tidy up casually. It removes the worktree and is
  destructive; archive instead unless the user explicitly asks to delete.
