---
"@sma1lboy/kobe": patch
---

fix: the worktrees page paints instantly — local signals (dirty, ahead-of-main, age) render first and the slow network lookups (ls-remote, gh PR states) swap in when they land, so a slow or dead remote can no longer hang the page. feat: `lastActive` — kobe now persists the last-focused task globally (last writer wins, no multi-TUI coordination) and opens on it after a daemon restart or fresh launch instead of falling back to the first task.
