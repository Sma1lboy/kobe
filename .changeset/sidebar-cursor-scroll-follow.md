---
"@sma1lboy/kobe": patch
---

The Tasks sidebar now scrolls when the task list is taller than the pane. Previously, once you had more tasks than fit on screen, pressing j/k (or the arrow keys) moved the selection but the list never scrolled — the highlighted task walked off the bottom edge and navigation looked frozen. Two things were wrong: the rail's outer box had its `flexShrink` silently forced to 0 by opentui's width setter, so it grew to its full content height instead of shrinking to the pane (leaving the inner scrollbox with nothing to scroll), and there was no effect to keep the cursor row in view. The rail is now bounded to the pane height and the viewport follows the cursor, matching the file-tree pane.
