---
"@sma1lboy/kobe": patch
---

Entering a task now goes through one Handover owner, so every path fits the window before switching and inherits global zen. Previously the Tasks-pane switch, the new-task/quick-task jump, and the delete-path switch-away each re-implemented "ensure session → fit → switch" and had drifted — the page-jump didn't follow global zen and the delete switch skipped the fit. Tasks opened from the new-task/quick-task pages now collapse to zen when it's on, and no enter path can land on an unfitted (reflowing) window.
