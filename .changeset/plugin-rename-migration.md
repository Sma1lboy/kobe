---
"@sma1lboy/kobe": patch
---

`kobe plugin update` now handles a plugin that renamed its id: settings and state move to the new id, the old registry entry is unregistered (no more duplicate hooks from two copies), and the stale checkout is reported rather than deleted.
