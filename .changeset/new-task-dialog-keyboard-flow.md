---
"@sma1lboy/kobe": patch
---

Reworked the new-task dialog into a single top-to-bottom keyboard flow. The mode tabs (For Existing / New Repo / Adopt) and the engine selector are now real focus stops — the dialog opens on the mode row so ←/→ switches the mode immediately, Tab walks down `mode → engine → repo → branch → Create`, and the Create button moved to the bottom-right where "tab through, then commit" expects it. Picking a directory in the repo / clone-parent pickers now **selects** it (Enter or click) and advances to the next field instead of drilling endlessly into its children; keep typing to browse deeper. Enter on the last field creates the task directly (no second press on Create).
