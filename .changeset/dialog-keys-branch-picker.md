---
"@sma1lboy/kobe": patch
---

Fix two task-pane issues while a dialog is open. Typing into a dialog's text input (e.g. the set-branch field) no longer fires the sidebar's plain-letter shortcuts underneath it — those keys were both triggering actions like delete/archive and being swallowed before the input could read them, because pane keybindings stayed live while a dialog overlaid them. The set-branch flow (sidebar `b`) now lists the repo's local branches with filter-as-you-type — matching the new-task dialog's branch picker — while still letting you type a new name to rename the branch to.
