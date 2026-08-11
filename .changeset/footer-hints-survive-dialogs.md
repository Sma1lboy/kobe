---
"@sma1lboy/kobe": patch
---

Keep the footer hint row (`⌃ A commands · F1 help · [settings]`) on screen while a dialog is open. Opening help with F1 used to blank the whole row, because reachability is computed against a stack that a modal barrier cuts short. The row now freezes its last non-modal captions and goes inert (clicks do nothing) until the dialog closes.
