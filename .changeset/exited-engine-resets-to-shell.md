---
"@sma1lboy/kobe": patch
---

A tab you exit claude in goes back to being a shell. Its state dot stayed lit in the sidebar and any keystroke — a stray `ls`, a typo — flipped it to "running" for a session that had already ended, while the row's own label had long since fallen back to `shell N`. The cause was that a tab's `kind` froze at birth: every tab IS a shell and an engine is just a process running inside it, so exiting one now resets the tab's state (its kind, session pin, and the engine's self-reported status title) instead of leaving each surface to guess whether the engine was still there. What belongs to the tab — your rename, its ordinal, split layout — survives.
