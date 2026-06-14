---
"@sma1lboy/kobe": patch
---

The task rail and Overview cards now show which engine a task runs (Claude, Codex, …) — but only when the workspace actually mixes engines, so a single-engine setup stays clean instead of repeating the same label on every row. The label is engine-owned (resolved through the engine registry), and the "is this a mixed-engine workspace?" check is a small shared, unit-tested helper.
