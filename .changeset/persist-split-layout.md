---
"@sma1lboy/kobe": patch
---

Split layouts now persist across restart. A group (tab) split into `claude | shell` — or a shell where you ran `claude` yourself — comes back with the same layout when you reopen kobe: `leaf-1` resumes the tab's engine session as before, and the other leaves respawn their shells fresh. The split tree is frozen onto the tab and stored in `state.json` (previously it lived only in memory and vanished on restart). Internally this replaces the module-level `splitsByTab` map with a single source of truth on the tab object.
