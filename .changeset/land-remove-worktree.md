---
"@sma1lboy/kobe": patch
---

`kobe api land --remove-worktree`: opt-in worktree removal after a successful land. The branch stays (pair with `--delete-branch` to drop it too); dirty worktrees are never forced, the base checkout and the caller's own worktree are never removed, and the cleanup outcome is reported in the result's `worktree` field instead of failing the land.
