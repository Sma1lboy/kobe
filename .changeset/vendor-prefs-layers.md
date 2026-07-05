---
"@sma1lboy/kobe": patch
---

Engine preference now layers per-project last-active over a Settings-owned global default: picking an engine via Ctrl+Shift+T or in the new-task/quick-task dialogs remembers it for that project only, and no longer clobbers the default engine set in Settings → Engines. Existing `lastSelectedVendor` values carry over as the global default.
