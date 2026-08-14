---
"@sma1lboy/kobe": patch
---

Prefix keybinding overrides now keep the chords that parsed when one entry in a list is invalid, instead of silently discarding the whole binding and reverting to the default — so a config like `chat.tab.new: [n, ctrl+shift+z]` still binds `n`, and the default is only kept (with a clear "no valid chords" warning) when nothing in the list is usable, matching how direct-chord overrides already behave.
