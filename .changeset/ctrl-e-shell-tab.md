---
"@sma1lboy/kobe": patch
---

ctrl+e now offers "shell" alongside the engine vendors — a plain terminal tab as a first-class tab type.

Previously the only way to get a bare shell tab was opening an engine tab and quitting it. The picked shell tab is a regular command tab: named by its live foreground process, closes itself when the shell exits, and never touches the repo's preferred-engine record.
