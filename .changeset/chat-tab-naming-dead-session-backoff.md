---
"@sma1lboy/kobe": patch
---

fix: the daemon's ChatTab auto-naming pass no longer hammers `tmux list-windows` against a task whose session doesn't exist (never entered yet, or its session was killed). A task whose session misses 3 consecutive polls now backs off exponentially (capped at 30s) instead of retrying every tick forever — this had flooded `daemon.log` to hundreds of megabytes and burned CPU for tasks with a long-dead session. Archiving or deleting a task now also proactively drops it from the poll set. A session that reappears (the user re-enters the task) resets straight back to full cadence.
