---
"@sma1lboy/kobe": patch
---

Fix auto-derived branch names showing a double hyphen (`kobe/<slug>--<id>`) when a long task title's 32-character slug cap lands on a word boundary: the trailing-hyphen trim ran before the cap, so the slice could re-introduce a trailing `-` that the `-<id>` suffix then doubled. The slug is now re-trimmed after the cap, so branches read `kobe/<slug>-<id>` cleanly regardless of where the title is truncated.
