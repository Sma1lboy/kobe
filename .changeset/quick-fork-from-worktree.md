---
"@sma1lboy/kobe": patch
---

Quick-fork now branches off the source task's worktree branch instead of the main checkout's branch, so the child task carries the parent's commits. The engine field defaults to the engine that task is already running (still switchable to any other detected engine in the composer).
