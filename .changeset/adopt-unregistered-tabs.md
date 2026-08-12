---
"@sma1lboy/kobe": patch
---

Live engine sessions the sidebar showed as unregistered `⚠` rows are now adopted into the task's tabs, so they can be opened, focused and closed like any other tab instead of only being reported. Closing a tab of a task this TUI never attached to also reaches the pty host now — the leak that produced those orphan sessions in the first place.
