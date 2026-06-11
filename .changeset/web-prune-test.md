---
"@sma1lboy/kobe": patch
---

Internal: cover the store's `pruneByTask` (the per-task side-table sweep that drops a deleted task's stale engine-state/job entries on each snapshot), including the same-reference-when-unchanged behavior that avoids needless re-renders. 87 web tests.
