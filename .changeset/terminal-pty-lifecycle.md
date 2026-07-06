---
"@sma1lboy/kobe": patch
---

Embedded-PTY lifecycle closes its loop (issue #16): archiving or deleting a task now releases every engine PTY its terminal tabs own (registry gains releaseWhere for task-scoped teardown), and quitting the KOBE_TUI workspace releases all of them — no orphan engine processes either way.
