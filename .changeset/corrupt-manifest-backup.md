---
"@sma1lboy/kobe": patch
---

A corrupt tasks.json is now backed up (tasks.json.corrupt-<timestamp>) before kobe recovers with an empty index — previously the next save silently replaced the corrupt file, permanently destroying whatever tasks its bytes still held.
