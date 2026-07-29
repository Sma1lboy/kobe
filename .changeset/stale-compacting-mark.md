---
"@sma1lboy/kobe": patch
---

Sidebar "compacting" can no longer stick: a cancelled compaction (no post-compact) or esc-interrupted turn clears its transient mark on the next fresh running edge (turn_complete/error/idle already did), and the compacting word now renders only while the row's animation is live — the label always serves the current state.
