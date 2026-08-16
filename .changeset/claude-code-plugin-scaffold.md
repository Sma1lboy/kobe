---
"@sma1lboy/rove": patch
---

Add the Claude Code plugin scaffold (`claude-plugin/` + root marketplace.json): hooks.json carrying the 12 Rove activity hooks via a bundled `bin/rove` wrapper resolved from `CLAUDE_PLUGIN_ROOT` (no PATH/alias dependency), the `rove` skill bundled under `skills/`, and an architecture test that pins hooks.json to the Claude hook adapter's event map so the two can't drift.
