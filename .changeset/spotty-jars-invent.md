---
"@sma1lboy/kobe": patch
---

Add Routines: scheduled agent tasks owned by the daemon. A routine is a cron rule + a prompt + a repo; every firing creates a fresh task (worktree + branch + engine session) with that prompt as its first message, so a scheduled run is an ordinary task you can open and keep talking to.

`ctrl+a` `2` (or the sidebar rail) opens the Routines page: `n` creates one through a card where Tab walks the fields, the repo is a scrolling picker, and the schedule is five labelled cells — ←/→ picks a cell, ↑/↓ changes it — with the next fire time restated in your own clock ("weekdays at 09:00 · in 2d · Mon 09:00"). A selected routine offers `[ run now ]` so you can find out it works without waiting for its schedule.

Also on the CLI: `kobe api routine-create/list/update/set-enabled/run-now/runs/delete`. An optional `--precheck` shell command runs before the engine starts — a non-zero exit skips the run without creating a task, so a schedule does not burn a turn when nothing changed. Run history distinguishes "nothing to do" from "needs a human". Schedules persist as absolute timestamps, so they survive a daemon restart and compensate for at most one missed occurrence within a configurable grace window. An enabled routine keeps the daemon alive so schedules fire with no TUI attached; disabling or deleting the last one restores the usual idle shutdown.
