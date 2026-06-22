---
"@sma1lboy/kobe": patch
---

TUI tmux sessions now stop a second differently-sized SSH/local client from letterboxing the active screen. Before attaching or switching into a task, kobe marks already-attached clients with conflicting terminal dimensions as `ignore-size` and sizes the target window from the entering client, so a monitoring terminal no longer shrinks the task grid on the screen you are actively using.
