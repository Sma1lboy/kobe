---
"@sma1lboy/kobe": patch
---

`kobe api fanout --agents <vendor>:<huge-count>` now rejects an over-cap count up front instead of allocating the whole array (and risking an out-of-memory) before the fanout cap check runs.
