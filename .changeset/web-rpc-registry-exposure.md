---
"@sma1lboy/kobe": patch
---

Web RPC exposure now derives from the daemon handler registry (`web: true` per entry) instead of a hand-maintained allowlist, and the web transport's error envelopes share the socket's `shapeDaemonError` policy.
