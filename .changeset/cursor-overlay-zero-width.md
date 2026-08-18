---
"@sma1lboy/kobe": patch
---

Keep the embedded terminal's cursor overlay on the character it's actually over when the line holds a zero-width mark. Combining accents (NFD text like café), emoji variation selectors, and joiners fold onto their base cell in the terminal, but the overlay had been counting each as its own column — so a mark to the left of the cursor drifted the inverse cell one column right, highlighting the bare mark instead of the char under the cursor. The same miscount let a row-end attribute (an underlined URL) leak past its last visible cell. Both now measure cells the same way the rest of the app does, so the overlay lands true and the seal covers the real last column.
