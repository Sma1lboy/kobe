---
"@sma1lboy/kobe": patch
---

Fix (TUI beta): closing the archived-history preview no longer spawns a live engine on the archived task. With `experimental.archivedHistoryPreview` on, opening an archived task shows a read-only `kobe history` pane in the engine slot — but pressing its "q close" key dropped to a bare shell and, on exit, routed through the engine pane's `engine-tab-exit` cleanup, which relaunches a live engine when it's the task's only tab. That re-ran a real `claude`/`codex` on an archived task (in a fallback dir when the worktree was already removed) — exactly what the preview is built to avoid. The preview is now a persistent read-only pane (like the Ops pane): it ignores SIGINT and re-launches itself instead of falling through to a shell or an engine, and the misleading self-close key is removed — leave the preview via the Tasks rail or Ctrl+Q like any other pane.
