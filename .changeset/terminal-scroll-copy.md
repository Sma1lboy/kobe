---
"@sma1lboy/kobe": patch
---

The embedded terminal now scrolls with the mouse wheel (same local scrollback channel as ctrl+pgup/pgdn) and supports copy-on-select: drag to select text and it lands on the system clipboard via OSC52 the moment you release — the tmux copy-mode convention, working over SSH too.
