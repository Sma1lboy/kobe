---
"@sma1lboy/kobe": patch
---

Internal: persisted boolean flags (zen on/off, zen keep-tasks, the experimental auto-status / dispatcher / remote-projects switches) now read through one `getPersistedBool(key, default)` owner instead of each inlining `x === true` / `x !== false`, where the idiom silently encoded the default and was easy to get backwards. No behavior change — the default-handling and the "don't coerce a non-boolean value" rule are now unit-tested in one place.
