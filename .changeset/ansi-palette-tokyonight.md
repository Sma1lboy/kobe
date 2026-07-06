---
"@sma1lboy/kobe": patch
---

The embedded terminal's basic-16 ANSI palette now uses Tokyo Night's published terminal colors instead of xterm's 1990s primaries, so `ls`/`eza` output and other bare-ANSI coloring reads as one coherent modern scheme (truecolor and 256-color output were always bit-exact and are unchanged).
