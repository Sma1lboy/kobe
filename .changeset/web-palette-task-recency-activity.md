---
"@sma1lboy/kobe": patch
---

The command palette (Cmd/Ctrl+K) now lists tasks most-recently-active first and shows a live engine-activity dot on each — so the task you were just in is near the top, and you can see at a glance which tasks are running, waiting, or idle while you jump. The activity dot reads live engine state at render, so it stays current without rebuilding the command list on every engine tick.
