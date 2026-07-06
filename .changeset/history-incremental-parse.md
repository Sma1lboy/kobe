---
"@sma1lboy/kobe": patch
---

Chat history polling no longer re-parses the whole Claude transcript every tick: appends parse incrementally and already-seen messages keep stable identity, eliminating per-poll row churn in the history pane.
