---
"@sma1lboy/kobe": patch
---

Surface live PTY sessions missing from the tab snapshot as explicit unregistered tabs (issue #20). The sidebar tree, `get-task`/`collect` tabs, and `inspect`'s tabs section now reconcile the persisted snapshot against the live session inventory at tab granularity: an alive `<taskId>::tab-N` session the snapshot does not list renders as a ⚠ unregistered row (TUI) / an `unregistered`-marked row (API) instead of being invisible — previously such an engine (e.g. the canonical-spawn fallback's orphan) ran with zero UI presence.
