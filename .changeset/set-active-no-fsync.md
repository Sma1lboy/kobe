---
"@sma1lboy/kobe": patch
---

perf: task focus switches no longer fsync a disk rewrite.

`setActiveTask` (the most frequent action in the TUI — every task/focus switch) used to call `store.update(id, {})` with an empty patch purely to bump `updatedAt` for the sidebar's `recent` sort. That still paid a full fsync'd read-merge-write (flock + read + merge + `handle.sync()` + rename) plus a full-list `task.snapshot` broadcast on every switch, all to move a field the default sort never reads. Recency is now a cheap in-cache `updatedAt` bump (`store.touchRecency`) that notifies listeners so `recent` still reorders live, but flushes lazily on the next real mutation — dropping the per-switch fsync'd disk write. The durable last-focused id is unaffected (it persists eagerly via `state/last-active.ts`).
