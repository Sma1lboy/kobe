---
"@sma1lboy/kobe": patch
---

Quota usage cache + Settings dashboard. The engine quota probe now returns full usage windows, and a daemon-owned cache becomes the only caller of the (itself rate-limited) vendor usage API: slow 15-minute refresh while a snapshot exists, exponential backoff (1m→2m→…, capped) while none can be fetched, a hard 60s per-vendor floor between attempts, shared in-flight dedupe, and strictly bounded memory (one snapshot per vendor). Snapshots fan out on the new `usage.snapshot` push channel, and Settings → General grows a top-right usage dashboard (per-window meters with utilization tone and reset time). The rate-limit auto-resume scheduler reads the same cache, so a hook event storm can no longer hammer the usage API.
