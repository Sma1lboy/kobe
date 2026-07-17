---
"@sma1lboy/kobe": patch
---

Fix focus dangling when you close the first pane of a terminal split while it's focused. Closing the leftmost/topmost leaf refocused the pane that was just removed, leaving keyboard routing and the focus highlight pointing at a leaf that no longer exists (a following focus-cycle would find no match); focus now moves to the surviving neighbour instead.
