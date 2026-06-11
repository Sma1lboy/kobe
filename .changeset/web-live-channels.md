---
"@sma1lboy/kobe": patch
---

The web task rail now renders the daemon's live activity channels: per-task `+N −M` uncommitted-change chips from `worktree.changes` (the daemon's single git-status collector — no browser-side polling) and a spinning "materializing…" row state from `task.jobs` while a worktree is being created, both hydrated from the bridge snapshot so a late-opened browser sees in-flight state immediately. The rail also shows a proper connecting state before the first snapshot instead of a misleading "No tasks yet".
