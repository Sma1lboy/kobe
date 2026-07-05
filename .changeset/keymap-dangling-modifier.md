---
"@sma1lboy/kobe": patch
---

Fixed a keybinding override where a dangling modifier chord (e.g. `ctrl+` or `cmd+alt+` in `keybindings.yaml`, with no key typed after the `+`) was silently bound to Ctrl+Plus instead of being rejected — kobe now reports a clear "no key after the modifiers" error, while the literal plus key (`ctrl++`, `+`) keeps working.
