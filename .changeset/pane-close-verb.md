---
"@sma1lboy/kobe": patch
---

`kobe api pane-close --title <t>` — the inverse of `pane-open`: closes every split pane / command tab in the task whose label matches the title it was opened with, over a new daemon `tab.close` channel the attached TUI consumes. Engine panes are never closed. Previously agent-opened panes could only be closed by killing their processes from outside, which raced with the split tree's remount-respawn.
