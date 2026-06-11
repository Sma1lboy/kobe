---
"@sma1lboy/kobe": patch
---

Task rows show a live "materializing" state while a large repo's worktree is being created. The daemon publishes lifecycle progress for the minute-class `task.ensureWorktree` operation on a new additive `task.jobs` channel (running → done/error, terminal phase guaranteed even on failure), and every attached Tasks pane — not just the one that initiated the switch — spins the row with a "materializing" subtitle until the `git worktree add` settles. The blocking RPC contract is unchanged; job entries are pruned against task snapshots so a task deleted mid-job never pins a phantom state.
