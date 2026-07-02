---
"@sma1lboy/kobe": patch
---

Add a per-task live preview mode: press `i` in the Tasks pane to toggle a task
between the live engine and a read-only LIVE preview — the `kobe history`
renderer tailing the transcript in the engine pane slot — for inspecting a task
an agent is working in without driving it. The history preview pane is now
live-refreshing (adaptive mtime poll shared with the Ops pane), so both the
archived preview and this new mode follow the transcript instead of showing a
one-shot snapshot.
