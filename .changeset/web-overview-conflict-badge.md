---
"@sma1lboy/kobe": patch
---

Overview cards now show the conflict-radar ⚠ badge the kanban board already carries: a task whose branch truly collides with another in-flight task is flagged right in the triage view (red for a proven merge conflict, yellow for a file overlap), with a hover tooltip naming the other task and the clashing files. The badge summary and tooltip text come from a shared, unit-tested helper in `lib/board.ts`, so the board and the Overview never drift.
