---
"@sma1lboy/kobe": patch
---

Add a Zen mode that collapses a ChatTab to the engine pane. Trigger it from the `zen` chip above the file list (left of `create PR`) or with tmux `prefix`+space; it hides the file/Ops and terminal panes, and the Tasks rail too unless the new Settings → General → "Keep Tasks pane in zen mode" toggle is on (default on, so the kept Tasks rail stays reachable to leave zen). A second press restores exactly the panes zen hid, leaving any pane you'd already collapsed untouched. While zen is active, the kept Tasks pane shows a `☯ ZEN` badge at its bottom-left as a mode reminder.
