---
"@sma1lboy/kobe": patch
---

feat: pane hosts log event-loop stall telemetry — a 1s heartbeat that, after any multi-second freeze, records the stall duration plus rss/heap to client.log, so "the TUI froze" reports can distinguish OS paging from an in-process block.
