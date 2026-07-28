---
"@sma1lboy/kobe": patch
---

test: lock in the task/worktree removal ordering — a dirty non-force delete is refused by the preflight before any session/PTY teardown (daemon handler, CLI verb, and orchestrator levels), orphaned worktrees still fall through to cleanup, and force semantics are unchanged.
