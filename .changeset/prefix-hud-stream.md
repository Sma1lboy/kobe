---
"@sma1lboy/kobe": patch
---

Prefix HUD: a small bottom-left overlay in the workspace terminal column that narrates PureTUI prefix sequences live — an armed `ctrl+a ⋯` line while waiting for the second stroke, then `ctrl+a + t → tab.new` (or `∅` on an unbound stroke) for each resolution. The last three lines stream like a mini log and flush after 4s. Escape/timeout cancellations disarm the line without leaving noise.
