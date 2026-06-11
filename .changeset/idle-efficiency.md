---
"@sma1lboy/kobe": patch
---

Big idle-efficiency pass — long-running kobe panes and the daemon now do dramatically less background work: task switches re-verify sessions with 4 tmux calls instead of 10 (attach/resize healing 6→3); turn/activity polling stops re-reading multi-MB transcripts when their mtime hasn't changed (Claude and Codex both — previously up to hundreds of whole-file reads per minute per pane); ChatTab auto-naming drops from ~450 to ~165 tmux calls/min by riding window options through the listing; sidebar branch labels stat .git/HEAD instead of spawning git every 2s (~150 spawns/min → ~0); the idle spinner tick no longer rebuilds every row's view 10×/s; the offline tasks.json poll is mtime-gated; the daemon serializes each broadcast frame once instead of once per subscriber; and keymap lookups are O(1) per keypress.
