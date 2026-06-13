---
"@sma1lboy/kobe": patch
---

The Overview header summary now includes an "N conflicting" count (red) alongside the existing need-input / running / dirty counts, so the fleet-level view of merge collisions is visible at a glance, not just per-card. It counts only tasks with a proven merge conflict among the shown set (file overlaps stay advisory on the cards) and hides itself when nothing is conflicting.
