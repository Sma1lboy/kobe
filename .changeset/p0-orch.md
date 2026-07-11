---
"@sma1lboy/kobe": patch
---

Land a task's branch back into its base repo (`task.land` RPC + `kobe api land`, TUI worktrees-page `l` key): merge/squash, refuse a dirty base checkout, abort on conflict and return the file list. Self-heal dead `worktreePath`s (clear on worktree removal, re-materialise onto the retained branch on next enter), delete the branch when a task is deleted, parallelise worktree listing probes, and consolidate the `(new task)` placeholder to one source.
