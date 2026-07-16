---
"@sma1lboy/kobe": patch
---

Tab turn chips + background-tab notifications now fire from engine hooks (sub-second) instead of waiting on the 3–6 s screen-quiescence poll. The daemon's per-tab engine-state push drives the strip's ●/✓/! chip directly — hook-wins per tab, with the quiescence poll unchanged as the fallback when hooks aren't installed. New `?` (warning) chip for a tab blocked on a permission prompt or question dialog. The daemon also arms a per-tab lapse watchdog so a missed Stop can't pin a tab at ● forever.
