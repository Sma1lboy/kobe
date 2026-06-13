---
"@sma1lboy/kobe": patch
---

The Tasks pane's keys-legend toggle (Shift+/) now stays in sync: a local collapse/expand of the keys hint is no longer immediately overwritten by a stale ui-prefs replay from the daemon (the prefs sync now reacts only to genuine daemon-payload changes). Thanks to Allen (@ZHallen122) for the fix.
