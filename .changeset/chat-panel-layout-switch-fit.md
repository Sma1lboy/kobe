---
"@sma1lboy/kobe": patch
---

Fix the workspace layout flashing to the aligned size the first time you open a task from the Tasks list — the target window is now fit + healed to your terminal before the switch lands, so it no longer reflows on screen. A manual Tasks-rail / right-column drag is also captured live, so it's no longer discarded when you then resize the terminal, and live-resize layout healing is coalesced so a drag-resize no longer thrashes.
