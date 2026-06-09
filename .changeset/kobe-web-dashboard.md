---
"@sma1lboy/kobe": patch
---

Add the local `kobe web` dashboard with task selection, independent vendor and terminal tabs, notes, worktree changes, centered file previews, and bundled Nerd Font terminal rendering. As of 2026-06-09, `kobe web` is an early experimental feature built for exploration and fun; it is not the primary kobe experience or a product commitment. The Web shell now has a task-search rail with project/worktree grouping, selected-task context in the top and bottom bars, and clearer no-task/no-worktree states for the workspace, Notes, and Changes surfaces. The production `kobe web` command also ships the built SPA and starts the Node PTY server alongside the daemon web transport, so terminal-backed tabs work outside the Vite dev launcher.
