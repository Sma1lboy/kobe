---
name: kobe
description: Use when controlling kobe tasks, parallel coding attempts, hosted agent sessions, task lifecycle, or the daemon-owned issue tracker from a shell.
---

<!-- kobe-skill-version: 3 — bump in lockstep with KOBE_SKILL_VERSION (src/lib/skill-install.ts). -->

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
`{"error":{"message","code"}}` on stderr. Add `--pretty` for readable output.

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
```

## Fan-out rules

Fan out only when the user requests parallel approaches, comparison, or an
explicit count. Give each task a scoped prompt, report returned IDs, then use
`collect` to compare. Do not recursively fan out from spawned tasks. Do not
poll `send` in a tight loop or use it as casual chat; every call is a full
engine turn.
