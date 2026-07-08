---
"@sma1lboy/kobe": patch
---

fix: cap `client.log` and `daemon.log` at 10MB with single-generation rotation, and hard-throttle the pane reconnect-failure log after 100 attempts until a successful reconnect resets it. Neither log had a size cap before — an incident with dozens of orphan panes spamming reconnect errors grew `client.log` to 736MB and `daemon.log` to 345MB; no long-lived process can grow either file unboundedly now.
