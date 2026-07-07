---
"@sma1lboy/kobe": patch
---

Embedded terminal: the drawn cursor now follows typed spaces. Trailing blank cells were dropped from the snapshot (the cursor-column seed was clobbered by the visible-cell scan), so the inverse-cell cursor froze at end-of-text while the real cursor advanced; the overlay also pads to the true cursor column as a backstop for backends that trim blank tails.
