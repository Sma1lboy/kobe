---
"@sma1lboy/kobe": patch
---

F7 attention jump goes tab-precise and question-aware. Engine tabs now launch with an inherited `KOBE_TASK_ID`/`KOBE_TAB_ID` env identity, so hook events tell the daemon exactly WHICH tab is waiting — F7 walks every waiting (task, tab) pair across all projects, starting with the other tabs of the task you're on, and switches straight to the target tab. Question dialogs (AskUserQuestion / elicitation) now count as blocked-on-you via a new `elicitation_dialog` Notification hook, and unseen turn-completions are navigable too — visiting one marks it read so the cycle always advances.
