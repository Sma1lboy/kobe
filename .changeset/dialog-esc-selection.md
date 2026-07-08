---
"@sma1lboy/kobe": patch
---

fix: esc could go permanently dead on open dialogs — a stale text-selection highlight (kept after a copy until the next click) disabled the dismiss binding entirely. First esc now clears the selection, the next closes the dialog; the engine picker's clickable esc label actually closes the card too.
