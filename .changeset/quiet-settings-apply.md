---
"@sma1lboy/kobe": patch
---

Fix Settings transparent-background changes so they persist and apply after closing the Settings page. The Settings page now flushes UI state before exit and refreshes only kobe-owned Tasks/Ops panes when visual preferences changed, leaving engine and shell panes untouched.
