---
"@sma1lboy/kobe": patch
---

The web dashboard gains an Overview (`/overview`) — mission control for running many sessions at once. It triages every worktree task into attention buckets (Needs you: waiting on input / rate-limited / errored · Working: engine running · Uncommitted changes: idle with a dirty worktree · Quiet), each a card with the activity dot, branch, change chips, and relative time that jumps to the task on click. A summary strip counts how many need input / are running / are dirty at a glance. Reachable from a top-bar button and the command palette ("Open overview").
