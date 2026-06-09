---
"@sma1lboy/kobe": patch
---

The workspace layout now stays consistent across tasks instead of resetting on each switch. The Tasks rail width, the right-column width, and the file-tree/terminal split are each remembered as one shared global size: drag any of them to your liking in one task and it's captured when you switch away, then applied to every other task (and to newly created tasks and `Ctrl+T` chat tabs). Sizes persist for the life of the tmux server (a normal quit/relaunch keeps them; `kobe reset` clears them back to the defaults). A user who never resizes the right column keeps today's default split untouched.
