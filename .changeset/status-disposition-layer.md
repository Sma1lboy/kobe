---
"@sma1lboy/rove": patch
---

Add a status→disposition layer (`@sma1lboy/kobe-daemon/daemon/status-disposition`): every Task/Issue status classifies as `active` (engine runs), `parked` (stop, preserve the worktree), or `terminal` (stop, worktree reclaimable), with unknown values fail-safing to `parked`. `issueColumnKey` now derives its Done column from the terminal disposition instead of a `=== "done"` string compare. Purely additive — no status value, wire shape, or visual change.
