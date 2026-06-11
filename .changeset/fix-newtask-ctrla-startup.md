---
"@sma1lboy/kobe": patch
---

Three latency/dead-key papercuts: `Ctrl+A` (line-home) works again in the New Task dialog's text fields — it was swallowed by the Adopt-tab select-all chord registered unconditionally with a handler-side gate (same class as the quick-task Enter bug); `kobe hook` no longer keeps the event loop alive ~500ms after each invocation (its stdin-race timer is now cleared); and engine binary discovery (`which` probes) is cached per process instead of re-running on every keypress and dialog open.
