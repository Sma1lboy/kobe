---
"@sma1lboy/kobe": patch
---

A sidebar tab row lights from its own activity instead of waiting to be opened.

The row asked the task-level activity map, which is a last-event-wins rollup across every tab — so a task whose live work sat in a non-active tab showed the resting `○` on every row, and only opening it revealed a running engine. The daemon has reported per-tab state all along (nothing consumed it); the tree now reads that first and keeps the task rollup as the fallback for sessions kobe didn't spawn as a tab, like a hand-typed `claude` in a shell.
