---
"@sma1lboy/kobe": patch
---

Repair the CI gates that had been red on main since the send foreground gate landed: the behavior suite's fake engine now keeps its own name in the process tree (it used to `exec sleep`, which erased it and made the delivery gate correctly report "no engine"), and the open-worktree journey presses ctrl+q before the sidebar-scoped `o` now that boot lands focus in the content pane. The Kanban pixel-diff assertion is gone — its baseline had a machine-specific engine picker baked in, so it could never pass on a clean runner; the journey still drives the real OpenTUI and asserts on the terminal buffer.
