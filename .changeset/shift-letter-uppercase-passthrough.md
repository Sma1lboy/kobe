---
"@sma1lboy/kobe": patch
---

Fix Shift+letter typing lowercase into the embedded terminal on kitty-protocol terminals — the CSI-u re-encode path synthesized from the lowercase key name and dropped the shift; the typed text ("Z") now forwards as-is.
