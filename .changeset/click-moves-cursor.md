---
"@sma1lboy/kobe": patch
---

Clicking a row in the Tasks sidebar now always moves the cursor to it. After navigating away with j/k inside a task's own pane, a mouse click (even on the pane's own task) couldn't bring the selection pointer back, because the click relied on `onSelect`, which a task-bound pane no-ops to keep its highlight pinned. The click now moves the cursor directly, decoupled from selection.
