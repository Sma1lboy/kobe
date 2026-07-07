---
"@sma1lboy/kobe": patch
---

Fix: clicking the embedded terminal now focuses it. opentui mouse events don't bubble to the workspace wrapper, and the terminal's own selection handlers consume the click, so a bare click inside the terminal never reached the global focus setter — you had to tab/arrow over from the task list. The pane now requests focus on click (and, when split, also selects the clicked leaf).
