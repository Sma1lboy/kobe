---
"@sma1lboy/kobe": patch
---

Fix the embedded-terminal cursor drifting away from the text when typing CJK / using an IME. The pane now shows the real terminal cursor at the engine's cursor cell (instead of drawing its own inverse-cell block), so there's a single cursor that stays wide-char-correct and that the OS IME / pinyin candidate window anchors to — the candidate popup and preedit follow the text instead of detaching. Shared `charWidth`/`displayWidth` moved to `lib/display-width.ts`.
