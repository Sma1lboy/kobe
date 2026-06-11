---
"@sma1lboy/kobe": patch
---

Internal: cover the diff client (`fetchDiff`) — the `/api/diff` query it builds (worktreePath + the optional `namesOnly`/`path` hints), response normalization to `files[]`/`raw`, and error handling (server error message vs status fallback). 96 web tests.
