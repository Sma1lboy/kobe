---
"@sma1lboy/kobe": patch
---

**Shortcuts now display as macOS key glyphs everywhere — including the tmux-prefix ones.** The footer, the F1 help, and the status bar all render chords the way a Mac user reads them at a glance — `⌃ Q`, `⌃⇧ T`, `⏎`, `⌃B F` — with a space between the modifier icons and the key. The two-step `prefix` chords show the prefix as a key cap then the key (`⌃B F` for "press your tmux prefix, then F"), and the help resolves your actual tmux prefix rather than guessing. `tab` stays the word `tab` (a glyph is overkill for it), and plain-letter chords keep their literal lowercase key (`n`, not `N`) so the legend is exactly what you type. A single `formatChord` helper now drives every shortcut display so they can't drift.
