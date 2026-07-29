---
"@sma1lboy/kobe": patch
---

fix: ctrl+w closes the active split leaf while split — the direct chord now matches prefix+w (`workspace.split.close` had prefix-only keys, so ctrl+w hit nothing in a split group while the tab-close binding was gated off)
