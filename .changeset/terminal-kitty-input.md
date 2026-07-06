---
"@sma1lboy/kobe": patch
---

Fix ctrl+c (and every ctrl-chord) passing into the embedded terminal on kitty-protocol terminals (Ghostty/kitty/WezTerm/iTerm2): the host renderer negotiates the kitty keyboard protocol, so chords arrived CSI-u encoded and were forwarded as garbage — ctrl+c literally typed a `c`. Kitty-encoded keystrokes are now re-encoded to the legacy bytes the embedded CLI expects; ctrl+space maps to NUL and ctrl+punctuation to its classic C0 codes (ctrl+\ SIGQUIT et al).
