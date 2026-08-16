---
"@sma1lboy/rove": patch
---

Sidebar IA convergence (issue #33 step 3): the Archived view leaves the sidebar entirely — no Active/Archived tabs, no `[`/`]` chord, archived rows simply don't render (they stay reachable via `rove api list` and the web board). The sidebar's only grouping dimensions are now ownership (projects) and intent (pinned/Scratch); lifecycle is inline badges. The active task keeps its pointer semantics (API default addressing + focus sync) with no dedicated screen area.
