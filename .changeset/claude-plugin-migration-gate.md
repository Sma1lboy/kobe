---
"@sma1lboy/rove": patch
---

Claude Code plugin migration hard-gate: when the Rove plugin is enabled, the launch-time settings.json hook install skips Claude (the plugin's hooks.json carries those events — no double firing) and prints a prompt-only warning for leftover settings-managed hooks or a pre-plugin `~/.claude/skills/rove|kobe` directory. New user-invoked `rove hook cleanup` removes only Rove's own settings-managed hook entries; nothing is ever removed silently. Skill install/staleness nags step aside in plugin mode (the bundled skill versions with the plugin), and `rove skill status` says so. Codex and other engines are untouched.
