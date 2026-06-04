---
"@sma1lboy/kobe": patch
---

External worktree sync is now ON by default. kobe ensures the global `WorktreeCreate` hook is installed on launch, so an external `claude --worktree` syncs into kobe as a task out of the box — no `kobe hook setup` step needed. It's idempotent (skips the write when already in place, so it never churns your `~/.claude/settings.json`) and honours an existing scope choice. Turn it off any time with `kobe hook setup --off`, or scope it to one repo with `--repo <path>`.
