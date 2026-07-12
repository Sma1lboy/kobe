---
"@sma1lboy/kobe": patch
---

Kanban lands in the TUI, wired for agents. `kobe api issue-update` gains `--task <taskId>` to link an issue to a task (`--task none` unlinks) — linking IS the board move: columns derive from the issue's own lifecycle (done → Done, linked task → In progress, everything else → Backlog), mirrored automatically back to Done when the task finishes. The workspace sidebar's new `c` chord opens a read-only kanban page (one project at a time — tab/←/→ cycles a rolling selector that starts on the project you opened kobe in — with three full-height bordered columns, `r` refetch, 5s poll) so you can watch agents file and move issues live. Issues render as real cards: bold wrapping title + `#id`, a two-line description preview, created date + hold badge, on a tinted surface that stays legible in transparent mode.
