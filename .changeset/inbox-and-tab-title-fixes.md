---
"@sma1lboy/kobe": patch
---

Fix four related Inbox / sidebar bugs.

The unread lamp no longer relights the moment you leave a tab you just read: the "seen" bit was keyed per task, so a sibling tab of the same task — which legitimately reports no activity — wiped the mark its completed sibling had just recorded in the same render pass. It is now keyed per tab.

The Inbox no longer silently drops episodes. Its tab lookup reads a per-task snapshot that only exists once this process has mounted that task's tabs; for every other task it answered "that tab is gone", and the background cleanup then deleted the episode from the daemon for good — so two tabs could be unread while the Inbox listed one. The lookup is now tri-state and an unreadable tab list keeps the episode.

An engine finishing in a shell kobe did not spawn now reaches the Inbox at all. Such a session inherits no `KOBE_TAB_ID`, and the daemon dropped every hook event that lacked one; it now records a task-level episode, which still navigates to the task.

Clicking into a tab no longer flashes the engine's live status line ("⠐ …") before settling back to its name. The live vendor comes from a ~2s process walk, so for one render there was no answer and the naming rule fell through to the raw recorded title; it now falls back to the tab's recorded identity first.
