---
"@sma1lboy/kobe": patch
---

perf: background engine PTYs no longer rebuild their full screen snapshot at output cadence — with no pane subscribed, the grid+scrollback conversion is deferred until the turn poll's next `capture()` (or a resubscribe), cutting per-session CPU roughly to the 1.5s poll rate while output streams unwatched.
