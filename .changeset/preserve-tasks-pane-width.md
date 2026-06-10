---
"@sma1lboy/kobe": patch
---

The workspace layout now stays consistent across tasks instead of resetting on each switch. The Tasks rail width, the right-column width, and the file-tree/terminal split are each remembered as one shared global size: drag any of them to your liking in one task and it's captured when you switch away, then applied to every other task (and to newly created tasks and `Ctrl+T` chat tabs). Sizes persist for the life of the tmux server: quitting and relaunching kobe keeps them (quitting kobe only detaches — the tmux server and its task sessions keep running), while anything that tears the tmux server down (`kobe reset`, `kobe kill-sessions`, or a reboot) clears them back to the defaults. A user who never resizes the right column keeps today's default split untouched. The first task opened on launch now also matches that shared layout immediately, instead of showing a wider rail until the first switch.
