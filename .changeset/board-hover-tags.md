---
"@sma1lboy/kobe": patch
---

**Move a board card without dragging** — hovering a card on `kobe web`'s `/board` slides in a bottom bar with one tag per primary status (`Backlog / In progress / In review / Done`); clicking a tag jumps the card straight to that column, landing at the top. The current column's tag is highlighted, the peek eye lives in the same bar, and tag moves go through the exact same optimistic-paint + rollback pipeline as drag-and-drop. `Error`/`Canceled` stay drag-only.
