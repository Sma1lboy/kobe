---
"@sma1lboy/kobe": patch
---

Auto-archive a task when its git worktree is removed. The global `PostToolUse` (Bash) hook that adopts a task on `git worktree add` now also detects `git worktree remove <path>` and archives the task pinned to that exact worktree — the symmetric complement to creation-time adopt. Archiving (not deleting) keeps the task's branch and history; an untracked worktree or a main/repo-root path is left untouched.
