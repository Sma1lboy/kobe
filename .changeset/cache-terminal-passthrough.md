---
"@sma1lboy/kobe": patch
---

Stop rebuilding the embedded terminal's ~850-entry key passthrough table on every output frame; it is now computed once and reused for the pane's lifetime.
