---
"@sma1lboy/kobe": patch
---

Sidebar transient state can no longer go stale: the compacting label is gone entirely (its end event is cancellable, so it never had a reliable clearing edge — compaction now reads as the running animation), an interrupt suppresses every activity older than it instead of decaying back into it after a few seconds, and subagent marks only render while the row animates.
