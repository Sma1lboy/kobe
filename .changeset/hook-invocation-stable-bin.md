---
"@sma1lboy/kobe": patch
---

fix: persisted engine hooks prefer the packaged `kobe` bin over the dev entry path

Global hook commands written into `~/.claude/settings.json` / `~/.codex/hooks.json` previously baked the absolute dev entry path (often inside a task worktree) when installed from a dev run — every hook fire then failed with "Module not found" once that worktree was removed. Hook installs now use `kobe` from PATH whenever a packaged bin exists, falling back to the dev invocation only when none is installed.
