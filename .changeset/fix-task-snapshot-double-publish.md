---
"@sma1lboy/kobe": patch
---

Internal: the orchestrator no longer double-publishes `task.snapshot` on daemon boot. `subscribeTasks` fired the listener directly AND returned the task store's own eager-on-subscribe firing, so the daemon broadcast the full task list twice back-to-back at startup (and threw a caught error on the not-yet-loaded path, since the store's `list()` asserts loaded). It now relies solely on the store's single delivery (eager when loaded, via `load()` otherwise). No behavior change beyond removing the redundant broadcast.
