---
"@sma1lboy/kobe": patch
---

Embedded terminal: the synthetic cursor cell is hidden while a mouse selection is active (tmux copy-mode behavior). Cursor and selection share the same inverse styling, so a cursor sitting just past the selection read as the highlight overrunning by one blinking cell.
