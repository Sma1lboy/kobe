---
"@sma1lboy/kobe": patch
---

**The board splits by project** — when tasks from 2+ repos share the board, a chip row appears in the header (one chip per project, labeled by path basename with `parent/basename` disambiguation on collisions, plus a card count); clicking a chip filters every column to that project, clicking it again (or `all`) clears the filter. The chip filter composes with the `/` text filter, survives route changes like the text filter does, and snaps back to `all` if the selected project's last card disappears. Single-project boards are unchanged — the row only renders when there is something to partition.
