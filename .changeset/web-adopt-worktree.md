---
"@sma1lboy/kobe": patch
---

The web dashboard can adopt existing git worktrees: a new Adopt-worktree dialog (the folder-in icon next to the task rail's `+`) scans a known repo for adoptable worktrees (`worktree.discoverAdoptable`) — showing each one's branch, dirty/kobe-managed flags, path, and last-activity time, with already-tracked worktrees marked instead of offered — and one click adopts a worktree into a task (`worktree.adopt`), selecting it. This makes the web UI self-sufficient for onboarding pre-existing worktrees without dropping to the TUI or CLI.
