---
"@sma1lboy/kobe": patch
---

Clearer terminal tab / split naming. A normal (single) tab is "tab N"; only a tab split into multiple leaves is a "group N". In a split, the engine leaf shows the conversation's first-prompt title (matching the group label) instead of a static "claude", and split shell leaves are named "shell" (deduped: "shell", "shell 2"). `F2` while split renames the active leaf.
