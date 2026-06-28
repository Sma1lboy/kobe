---
"@sma1lboy/kobe": patch
---

Internal: the workspace's intended layout geometry (Tasks-rail width + right-column split) now resolves through one owner instead of being re-parsed/re-clamped/re-defaulted at every reader. No behavior change — the pure resolver is unit-tested, so the rail/right-column sizing is a regression-netted single source.
