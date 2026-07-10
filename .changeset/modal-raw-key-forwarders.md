---
"@sma1lboy/kobe": patch
---

Keys typed into an open dialog no longer leak into the pane behind it: raw `keyInput` listeners that bypass the keymap dispatch (the terminal pane's IME/paste catch-all, the sidebar's search capture) now honor the dialog modal barrier via `modalActive()`.
