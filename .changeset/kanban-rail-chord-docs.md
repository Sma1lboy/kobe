---
"@sma1lboy/kobe": patch
---

Fix the keybindings doc still calling the Kanban `prefix+c` after it moved to
`prefix+1` with the sidebar rail, and point the visual ground-truth journey at
the new chord. The journey had been asserting the word "Kanban" — which the rail
now prints permanently — so it read as passing whether or not the board opened.
