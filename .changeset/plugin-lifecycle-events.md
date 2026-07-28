---
"@sma1lboy/kobe": patch
---

Unified agent lifecycle events for plugins (docs/design/plugin-events.md): plugin `[[events]]` hooks can now subscribe to the full normalized lifecycle — `session.start/end`, `turn.prompt/complete/failed/interrupted`, `tool.pre/post/failed`, `attention.permission/question`, `context.pre-compact/post-compact`, `subagent.start/stop` — engine-agnostic across Claude Code and Codex. Installed hook commands are vendor-tagged (`--engine`), lifecycle-only kinds bypass the activity badge and reach only subscribing plugins, and the high-volume tool hooks are written into engine config only while an enabled plugin declares a `tool.*` event.
