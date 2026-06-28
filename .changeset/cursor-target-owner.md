---
"@sma1lboy/kobe": patch
---

Internal: the sidebar's "where should the cursor go when the selection or the list changes" rules (follow selection, clamp a dangling cursor when the selected task vanished from another surface, snap an unset cursor) now live in one pure, unit-tested function instead of inline branches in the render effect. No behavior change — this is the area three recent selection/highlight fixes came from, now regression-netted.
