---
"@sma1lboy/kobe": patch
---

Fix a batch of TUI user-story logic bugs: Tasks-pane o/b/v now act on the
cursor row (not the active task) and deleting/archiving a background task no
longer steals focus; Shift+P (pin) is wired and Shift+M help matches its
reorder behavior; the file tree keeps its cursor across fs-watch refreshes and
reuses the tab cache; new-task base-ref prefers an exact branch match; git
clone no longer hangs on credential prompts; the git-HEAD poller stops caching
an empty branch label; error toasts always surface; plus untracked line counts,
typechange rows, surface-window Ctrl+h/tab-switch guards, CJK legend width, and
the update banner version.
