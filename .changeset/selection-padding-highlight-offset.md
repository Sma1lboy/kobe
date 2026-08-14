---
"@sma1lboy/kobe": patch
---

Dragging a terminal selection into the blank space to the right of a short line now highlights the cells you actually dragged over, instead of a same-width block shoved back against the end of the text. Rows in the embedded terminal are trimmed, not grid-padded, so a selection that starts in that trailing padding was painting its inverse-video highlight from where the line's text ended rather than from where the drag began — the copied text was already correct, only the on-screen highlight was misplaced.
