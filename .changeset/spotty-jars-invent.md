---
"@sma1lboy/kobe": patch
---

Add Automations: scheduled agent tasks owned by the daemon. An automation is a cron rule + a prompt + a repo; every firing creates a fresh task (worktree + branch + engine session) with that prompt as its first message, so a scheduled run is an ordinary task you can open and keep talking to.

Manage them with `kobe api automation-create/list/update/set-enabled/run-now/runs/delete`. An optional `--precheck` shell command runs before the engine starts — a non-zero exit skips the run without creating a task, so a schedule does not burn a turn when nothing changed. Run history distinguishes "nothing to do" from "needs a human". Schedules are persisted as absolute timestamps, so they survive a daemon restart and compensate for at most one missed occurrence within a configurable grace window. An enabled automation keeps the daemon alive so schedules fire with no TUI attached; disabling or deleting the last one restores the usual idle shutdown.
