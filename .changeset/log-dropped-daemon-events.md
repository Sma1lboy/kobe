---
"@sma1lboy/kobe": patch
---

Log dropped/malformed daemon events instead of silently swallowing them. When the daemon publishes a bad frame, `RemoteOrchestrator.handleEvent` now records one tagged `client.log` line at each shape/type-guard drop site (task.snapshot, engine-state, task.jobs, worktree.changes, ui-prefs, keybindings) before discarding the event, so a frozen-task-list incident is diagnosable. Control flow is unchanged — malformed frames are still dropped, never acted on.
