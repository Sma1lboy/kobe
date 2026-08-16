---
"@sma1lboy/rove": patch
---

The Routines schedule preview now floors its "next run in …" countdown instead of rounding up, so it never promises more headroom than a schedule actually has: a run 90 minutes out reads "in 1h" (not "in 2h") and one 36 hours out reads "in 1d" (not "in 2d"), matching how the plugins list already phrases elapsed time.
