---
"@sma1lboy/rove": patch
---

`land` now refuses to merge a branch with zero commits ahead of the base instead of silently landing a no-op. If the task's worktree still holds uncommitted files, the error (`EMPTY_BRANCH_DIRTY_WORKTREE`) lists them and carries an executable recovery path (`hint` + `nextCommandArgs`) that sends the worker back to commit its own work; a clean worktree fails with `EMPTY_BRANCH` and no auto-recovery, surfacing the "worker reported success but delivered nothing" case for a human.
