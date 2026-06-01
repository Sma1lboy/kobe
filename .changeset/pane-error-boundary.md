---
"@sma1lboy/kobe": patch
---

Tasks and Ops panes no longer hard-crash into a red error dump. A transient render throw — e.g. a frame during a task delete where a reactive lookup briefly hits the just-removed task — used to take the whole `kobe tasks` / `kobe ops` pane down to opentui's raw red stack, since neither pane had an error boundary. Both panes now wrap their render tree in a self-healing boundary: the error is logged and shown as a calm one-line state, the Tasks pane resets automatically on the next task snapshot (so a delete-frame transient clears itself), and a capped timer retry covers cases without a snapshot signal.
