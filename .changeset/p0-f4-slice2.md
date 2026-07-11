---
"@sma1lboy/kobe": patch
---

`kobe api send`/`spawn-task`/`fan-out` now route prompt delivery, liveness, and teardown to a task's actual backend. A pty-host (default) task is delivered into its live engine over the pty socket instead of being mistaken for "not running" and silently opening a second tmux engine in the same worktree — a data-corruption bug where two agents clobbered the same files. When a hosted task's engine tab is gone, delivery returns delivered:false rather than double-opening.
