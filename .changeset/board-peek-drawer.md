---
"@sma1lboy/kobe": patch
---

**Peek a session from the board** — every card on `kobe web`'s `/board` grows an eye button that slides in a drawer with the task's LIVE engine terminal and transcript, no navigation away from the board. The drawer attaches to the same server-side PTY the workspace drives, so it's one engine session viewed from two places; closing the drawer only detaches (the session keeps running, scrollback replays on reopen), and `Esc` closes it except while the terminal owns the keyboard.
