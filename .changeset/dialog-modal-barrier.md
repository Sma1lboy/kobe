---
"@sma1lboy/kobe": patch
---

fix: an open dialog now structurally blocks every key from reaching the UI behind it — the keymap gained a modal barrier that cuts off all bindings registered before the dialog opened (the dialog's own keys and its text inputs keep working). Previously each pane had to gate itself on "no dialog open" and any missed gate (the F1 help card was one) let keys operate the background.
