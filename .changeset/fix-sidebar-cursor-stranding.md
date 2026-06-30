---
"@sma1lboy/kobe": patch
---

fix: Tasks pane no longer strands a stale cursor on a jumped-to project

In a task-bound Tasks pane the selection is pinned to its own task (`onSelect`
no-ops), but clicking/Entering another project moved the pane's cursor to that
row before jumping the client away. Because the cursor-sync effect only re-runs
when `selectedId` changes — and a pinned pane's never does — the cursor stayed
stranded on the jumped-to row. Switching back then showed that stale cursor as a
second selection while the pinned project was the one actually open ("top-left
selection unreasonable" when clicking project A then B then back). Jump-away now
snaps the cursor back to the pinned row via a new `pinnedSelection` Sidebar prop.
