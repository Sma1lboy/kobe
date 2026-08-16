---
"@sma1lboy/rove": patch
---

Record per-turn agent telemetry. Every completed engine turn now leaves an attributed record — task, tab, engine, model, start/end time, and token usage — read back with `rove api agent-turns` (filter by task or repo; the response carries a totals roll-up alongside the page).

The turn data is engine-owned: each adapter lifts it from its own transcript, so nothing outside the engine layer parses a vendor's files. Claude Code ships the first reader; other engines contribute nothing until theirs lands.
