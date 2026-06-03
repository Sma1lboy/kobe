---
"@sma1lboy/kobe": patch
---

Opening a task for the first time no longer flashes the spawned session's Tasks pane back to the top row. Before, the freshly built pane briefly highlighted the previously-entered task (often the first one) before snapping to the right one.

Root cause: a spawned Tasks pane initializes its highlight to its own task (`initialTaskId`), but then subscribes to the daemon, which replays the last cached `active-task` value. Because `switchTo` publishes `setActiveTask(id)` only *after* `switch-client`, the replayed value is the pre-switch task — so it clobbered the correct selection for a frame until the new `setActiveTask` landed.

Fix: a pane spawned for a task session is the authority for its own initial highlight, so it now ignores replayed `active-task` values until the channel confirms its own task, then resumes following shared focus normally. Home panes (no `initialTaskId`) are unchanged.
