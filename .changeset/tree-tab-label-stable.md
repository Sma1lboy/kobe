---
"@sma1lboy/kobe": patch
---

Sidebar tab rows show a stable name instead of the engine's frozen status line.

claude and codex both put live activity in their terminal title, and the tree renders tabs it does not host — so with no live stream to refresh it, a row fell back to the last recorded title and sat wearing a stale spinner phrase (`⠐ 利用自进化…`) that contradicted the state glyph right beside it. kobe derives that glyph from daemon activity; the name now comes from the tab's own stable identity (manual rename, else the first-prompt summary, else the engine default). Engines that don't claim their title, like copilot, keep showing their real process name.
