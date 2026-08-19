---
"@sma1lboy/rove": patch
---

The sidebar's right-click menu can start a new conversation or shell

A Task row (and any of its tab rows) now offers **New conversation** and **New
shell** alongside open/rename/archive. The first opens the same `ctrl+e`
engine/shell picker that tab strip answers to; the second takes that picker's
shell pick directly and lands a bare terminal tab named by its live foreground
process. Mouse users had no route to either — the only way to add a session to
a worktree was to enter it and press the chord.

Both entries ENTER the Task first, then hand the request to its workspace: the
picker is a dialog and a shell tab has to spawn its PTY where the tabs render,
so unlike the menu's close/reorder entries there is no background path. A
request aimed at a worktree whose tabs are not mounted yet is claimed by their
first mount, which the activation triggers.
