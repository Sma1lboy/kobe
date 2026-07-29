---
"@sma1lboy/kobe": patch
---

`ctrl+1` … `ctrl+9` / `ctrl+0` jump straight to the Nth task in the sidebar's visible list, from anywhere including inside the engine pane. The index follows the current filter/sort/search order, and a digit past the end does nothing rather than clamping. Needs a kitty-keyboard-protocol terminal (iTerm2 / kitty / WezTerm); on legacy terminals the chords are inert rather than stealing escape/backspace.
