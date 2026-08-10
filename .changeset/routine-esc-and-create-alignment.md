---
"@sma1lboy/kobe": patch
---

Fix esc doing nothing in the New routine dialog, and move the new-task Create button to the bottom right.

The routine composer bound `escape` itself and only resolved its promise, never popping the card off the dialog stack — and as a modal member it outranked the barrier that would have closed it, so the dialog stayed up with no way out but ctrl+c. It now leaves esc to the barrier. The new-task dialog's action row used `space-between` with a single child, which left Create hugging the left edge; it now sits bottom-right like every other card.
