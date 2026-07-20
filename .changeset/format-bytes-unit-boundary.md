---
"@sma1lboy/kobe": patch
---

Fix the binary/image preview size line rounding up to a bogus "1024 KB" (or "1024 MB") at a unit boundary instead of promoting to "1.0 MB" (or "1.0 GB") — file sizes within half a kilobyte of the next unit now roll over to the larger unit as expected.
