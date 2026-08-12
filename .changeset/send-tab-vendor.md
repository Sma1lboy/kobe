---
"@sma1lboy/kobe": patch
---

`kobe api send --tab new` takes a `--vendor` now, so one worktree can run two different agents on the same files — hand stuck work to codex without leaving the branch, the API twin of the TUI's ctrl+e engine pick. The engine is pinned to that tab (survives restarts and a later `set-vendor`) while the task's own vendor is left alone; `--vendor` on an existing tab is refused rather than silently downgraded to the task's engine. Skill version 19 documents the routing.
