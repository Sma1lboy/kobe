---
"@sma1lboy/kobe": patch
---

**Archived tasks no longer cost any daemon polling work.** The daemon's 4s auto-title loop has two passes — the task title pass and the ChatTab window-naming pass — and both used to iterate every task in the index, archived included. For each archived regular task the window-naming pass shelled out to `tmux list-windows` plus per-window option queries and transcript reads on every tick, so the cost grew with the size of your archive and never settled. Both passes now skip `archived` tasks before any disk/tmux work (matching the sidebar's `t.archived` split). Un-archiving a task re-includes it on the very next tick, so a placeholder-titled task you bring back still auto-names normally.
