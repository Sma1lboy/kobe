---
"@sma1lboy/kobe": patch
---

Internal: the daemon's `task.status` handler now validates an inbound status against a single source of truth — `TASK_STATUSES` / `isTaskStatus` in `types/task.ts`, kept in sync with the `TaskStatus` union by a compile-time exhaustiveness check — instead of a hand-maintained six-way `!==` chain that would silently drift when a status is added. No behavior change.
