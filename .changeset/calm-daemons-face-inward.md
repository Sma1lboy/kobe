---
"@sma1lboy/kobe": patch
---

Make the daemon package dependency direction explicit: daemon transport code now consumes a host runtime Adapter instead of importing kobe source aliases, with a CI test pinning the acyclic seam.
