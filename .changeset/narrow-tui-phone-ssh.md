---
"@sma1lboy/kobe": patch
---

Narrow mode for phone-SSH terminals (issue #14, phase 1): below 70 cols the workspace collapses to a single-panel layout — sidebar and workspace render as mutually exclusive full-screen surfaces (enter a task for the workspace, the existing ctrl+q comes back to the list; no new chords), the files pane stays hidden (spec addendum: three panes don't fit 46 cols), the tab strip condenses to the active tab plus a 2/3 counter, the footer keeps one session-window usage chip per vendor with hints collapsed to their chord caps, the prefix HUD goes full width, dialogs clamp centered with halved body padding, and the sidebar gains a "↩ Recent" jump row back into the last-entered task (persisted via lastActive, so a cold reconnect keeps it). Desktop layouts at ≥70 cols are unchanged. Also fixes selectTask skipping the active-task publish when re-entering the already-selected task.
