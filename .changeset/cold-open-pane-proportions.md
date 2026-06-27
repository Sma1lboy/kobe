---
"@sma1lboy/kobe": patch
---

Opening a task whose tmux session wasn't running no longer lands with all panes squished to near-even widths. The session was created at the Tasks-pane host's narrow pty width and its panes were split at that size, so growing the window to the real terminal later only redistributed proportionally — the fixed-width sidebar rail ballooned and the layout went uniform. The window is now fitted to the real client size before the panes are split, so a cold-opened task shows the intended proportions (narrow rail, wide chat, right column) from the first frame.
