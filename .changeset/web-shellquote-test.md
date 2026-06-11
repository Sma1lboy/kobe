---
"@sma1lboy/kobe": patch
---

Internal: cover the bridge's `shellQuote` (it builds the engine launch command line that runs in the worktree) with tests, including injection attempts — a value with an embedded quote or shell metacharacters must stay a single quoted token and never break out to run extra commands. No behavior change.
