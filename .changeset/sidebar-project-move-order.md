---
"@sma1lboy/kobe": patch
---

fix: sidebar project move-mode actually moves — order keys on mains, cursor follows its row

Project order in the sidebar tree now follows the MAIN tasks' stored order (the partition `moveTask` swaps), so moving a project visibly moves its header — previously an older regular task anchored the group and the swap read as a no-op. And in move mode the cursor re-anchors to its row id across the reorder instead of its flat index, so it stays on the project being moved rather than landing on a neighbour.
