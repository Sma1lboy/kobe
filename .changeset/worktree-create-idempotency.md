---
"@sma1lboy/kobe": patch
---

Make worktree creation idempotent and self-cleaning on partial failure. If recording the new worktree's path fails (or the task is deleted mid-create), `ensureWorktree` now rolls back the just-created worktree and frees its slug, so a retry no longer collides with orphaned on-disk debris. A worktree created moments before a concurrent delete no longer throws a spurious "task not found". Adopting multiple worktrees now reports a real N/M summary instead of hiding the ones that succeeded behind a generic error.
