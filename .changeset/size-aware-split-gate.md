---
"@sma1lboy/kobe": patch
---

Split nesting is now bounded by screen size instead of a fixed 4-level depth cap: a split (chord, `pane-open`, or ctrl+e pane) is allowed as long as every resulting pane stays at or above the minimum usable size (20×6 cells), judged from the focused leaf's live terminal geometry. Big screens can nest deeper than before; small ones fall back to a tab sooner. The depth cap remains only as a fallback when no size is known.
