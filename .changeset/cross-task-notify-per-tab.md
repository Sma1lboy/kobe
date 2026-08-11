---
"@sma1lboy/kobe": patch
---

Cross-task notifications no longer swallow the second tab to finish. The rising-edge notifier diffed the task-level activity map, which the daemon writes as a last-event-wins rollup across every tab — so when two tabs of one task completed in a row, the rollup was already sitting at the first one's state and the second fired no edge. Two agents finished, you heard about one. The diff now runs per tab (tasks whose engine reports no tab identity keep the rollup), and the toast names the tab it came from.
