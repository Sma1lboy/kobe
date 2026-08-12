---
"@sma1lboy/kobe": patch
---

fix: ctrl+w closes a tab in one press again — the sidebar's orphan-adoption backstop (a 2s `pty.list` poll) could still see the just-killed session as alive and adopt the closed tab straight back into the strip. Closes now note their pty key for a 15s window that orphan detection skips, long enough for the host to observe the kill, short enough that a genuinely unkillable session still resurfaces as an orphan.
