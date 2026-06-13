---
"@sma1lboy/kobe": patch
---

**Board cards keep a manual order inside each column** — dragging a card within a `kobe web` board column now persists its slot via a new `task.reorder` daemon RPC and a sparse fractional `position` on the task (web-board-only: the TUI sidebar's ordering and `recent` sort are untouched, and a reorder never bumps `updatedAt`). Un-dragged columns now order by creation time instead of last-update, so cards stop shuffling while engines run. Terminal columns (`Done`/`Canceled`/`Error`) cap at the 30 most recent cards with a `+N more` note — archiving stays the way to thin them.
