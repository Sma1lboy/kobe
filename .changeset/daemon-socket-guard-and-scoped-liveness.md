---
"@sma1lboy/kobe": patch
---

Fix the daemon split-brain behind "tab still running but the sidebar dot is gone": daemon startup now probes the socket and refuses to replace a live daemon instead of silently unlinking its socket (the churn that split hooks and the TUI across two daemons); the activity lapse watchdog probes the reporting session's own transcript instead of the whole worktree, so a sibling tab's Stop no longer idles a mid-turn engine sharing the same checkout; and the daemon web transport default moved from 5174 (routinely squatted by stray Vite dev servers, silently disabling the dashboard) to 45174.
