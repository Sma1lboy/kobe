---
"@sma1lboy/kobe": patch
---

Keep the desktop Agent Trace attached to the active conversation when Codex
resumes a session that previously appeared in the same chat tab. A confirmed
resume now creates a fresh current EngineRun instead of being retained as a
late event on the historical run.
