---
"@sma1lboy/kobe": patch
---

Show subscription quota as soon as the first TUI subscriber attaches instead of leaving the workspace footer empty until the next 60-second daemon poll. Headless daemons still skip dashboard-only quota probes, and the existing per-vendor rate limit, retry backoff, and in-flight deduplication remain unchanged.
