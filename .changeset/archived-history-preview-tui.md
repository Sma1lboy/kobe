---
"@sma1lboy/kobe": patch
---

Beta (TUI): preview an archived task's engine history in the engine pane. With the `experimental.archivedHistoryPreview` gate on (Settings → Dev → Experimental, shared with the web dashboard), opening an archived task launches a read-only `kobe history` pane — a session selector + scrollable transcript — into the engine pane slot instead of relaunching the engine. It reads the vendor transcript store (claude/codex/copilot) by the recorded worktree path, so it works even after `git worktree remove`; the worktree is never re-materialized, no init script or status/dispatcher protocols run, and panes fall back to the repo (or home) when the worktree dir is gone.
