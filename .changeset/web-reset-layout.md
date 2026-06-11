---
"@sma1lboy/kobe": patch
---

Settings gains a "Reset layout" recovery action (two-click confirm): it clears the per-task workspace tab layout (open tabs, splits, selection) back to empty and kills the open tabs' PTYs, for when the localStorage-persisted layout gets wedged or cluttered. Pure browser state — tasks, worktrees, and notes are untouched.
