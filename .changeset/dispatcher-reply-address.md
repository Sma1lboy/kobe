---
"@sma1lboy/kobe": patch
---

Tasks now record the kobe session that dispatched them (`dispatcher: {taskId, tabId}`), so a worker's reply reaches the tab the work was dispatched from. `add`/`fan-out` stamp it from the caller's `$KOBE_TASK_ID`/`$KOBE_TAB_ID`; a bare `kobe api send` (no `--task-id`) inside a dispatched task delivers to that exact tab, falls back to the dispatcher task's live canonical engine tab when it died, and fails loud with `DISPATCHER_UNREACHABLE` when nothing there is alive — never a silent new engine. `[KOBE PEER]` reply commands are now tab-precise, and `get-task`/`collect` expose the dispatcher for lineage reads.
