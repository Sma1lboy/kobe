---
"@sma1lboy/kobe": patch
---

Fixed quitting an inline page (`kobe update list`) leaving mouse-tracking escape reports flooding the shell prompt — every pane host now restores the terminal on process exit, whatever the exit path. The onboarding wizard also flows as a transcript now: answered questions stay on screen as checked lines, the next question follows below, and inline pages no longer paint a background block over the shell.
