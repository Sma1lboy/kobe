---
"@sma1lboy/kobe": patch
---

The web dashboard's Task panel gains a "Copy link" button next to "Copy path": it copies the task's deep link (`<origin>/task/<id>`) so you can paste it to a teammate or yourself and land straight on that task. Built on a new reusable clipboard helper with an execCommand fallback for non-secure contexts.
