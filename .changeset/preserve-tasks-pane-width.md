---
"@sma1lboy/kobe": patch
---

The Tasks rail now keeps one consistent width across every task instead of resetting on each switch. Drag the rail to the width you like in any task and it becomes the shared global width — captured when you switch away and applied to every other task (and to newly created ones), so switching tasks no longer changes the sidebar size. The width persists for the life of the tmux server (a normal quit/relaunch keeps it; `kobe reset` clears it back to the default).
