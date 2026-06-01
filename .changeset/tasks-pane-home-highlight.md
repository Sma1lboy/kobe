---
"@sma1lboy/kobe": patch
---

Entering a freshly-built task no longer leaves the Tasks pane highlight stuck on the first row. When a task's tmux session is built from scratch, its `kobe tasks` pane starts as a new process and could miss the `active-task` broadcast that races its subscribe, so its cursor defaulted to the first task. The pane now reads the task its own session belongs to (the session's `@kobe_task` tag) before first render and uses that as the initial highlight, so the cursor lands on the task you entered. The shared active-task focus still follows live cross-session switches.
