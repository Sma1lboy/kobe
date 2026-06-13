---
"@sma1lboy/kobe": patch
---

The task rail now shows the conflict-radar ⚠ badge on its rows, completing the cross-surface story — a task whose branch collides with another in-flight task is now flagged in the always-on rail, the Overview, and the board alike (red for a proven merge conflict, yellow for a file overlap, hover names the counterpart). The simple-tooltip badge is now a shared `ConflictChip` next to `PrChip`/`ChangesChip`, and both the rail and the Overview render it from the same unit-tested `lib/board.ts` helpers.
