---
"@sma1lboy/rove": patch
---

Deleting a task with the "also delete the branch" opt-in now honors that choice even if the daemon restarts mid-deletion: the `deleteBranch` flag is durable state, but the store's load path was dropping it, so a queued deletion that survived a restart tore down the worktree while silently keeping the branch. The flag now round-trips through disk, matching every other persisted deletion field.
