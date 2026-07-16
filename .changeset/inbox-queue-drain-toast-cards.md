---
"@sma1lboy/kobe": patch
---

The attention Inbox is now a queue that drains: opening an episode removes it (no more read/unread lifecycle or Unread/All filter), a fresh event on the same task+tab replaces the stale one at the latest position, and the list reads oldest → latest top-down. The header badge counts pending episodes. Toasts got the matching two-line card treatment: semantic accent bar + bold title row + optional muted context line (task title for tab toasts, project for cross-task toasts).
