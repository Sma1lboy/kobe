---
"@sma1lboy/kobe": patch
---

refactor: the daemon's per-tab activity state now follows herdr's multi-source arbitration model — hook events and observer (PTY/foreground) facts occupy separate slots on each tab's record, and one pure `recomputeTabActivity` decides the effective sidebar state (sticky hook > hook > observed, with a freshness guard so a stale observation can never idle a fresh turn). Wire protocol and displayed states are unchanged; observed-rest corrections of a stale hook `running` now also require the observation to be newer than the claim.
