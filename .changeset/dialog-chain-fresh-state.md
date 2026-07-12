---
"@sma1lboy/kobe": patch
---

Fix Settings → Engines "+ Add engine": chained dialog prompts (id → command → name) reconciled in place and leaked the previous prompt's input text, corrupting the saved custom engine's command and name. Each dialog stack entry now remounts fresh, so custom engines save cleanly and appear in the ctrl+e engine picker.
