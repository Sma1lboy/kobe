---
"@sma1lboy/kobe": patch
---

Switching between tabs of the same worktree no longer spins the tab you switch to. A tab row with no activity of its own borrowed the task-level rollup whenever it was the active tab — but that rollup is last-event-wins across every tab, so it was describing whichever sibling was actually running. The rollup now only stands in for a task whose engine reports no tab identity at all (a `claude` typed into a plain shell, which has no tab id to tag its hook events with). Also removes the dead `titleDisplayName` helper.
