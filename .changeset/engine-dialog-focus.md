---
"@sma1lboy/kobe": patch
---

Fix losing focus on every Enter while adding an engine in Settings → Engines. The chained id → command → name prompts each closed before the next opened, and the closing dialog's deferred refocus timer fired ~1ms into the new prompt, pulling focus back to the pane behind it. Opening a dialog now cancels a pending refocus, so any chained dialog flow keeps its input.
