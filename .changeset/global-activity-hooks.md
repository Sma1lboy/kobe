---
"@sma1lboy/kobe": patch
---

Move engine activity hooks from per-task worktree installs to a single GLOBAL hook in `~/.claude/settings.json`. The per-task approach (writing `.claude/settings.local.json` into each worktree, baking the task id) had to fire at exactly the right moment, only took effect after entering a task, never reached an already-running engine, and could leak into a project's real repo root. Now one merge-safe block installs on launch and makes EVERY Claude session report `kobe hook <verb>` carrying its `cwd`; the daemon maps that cwd to a task by worktree path. Every existing task lights up at once — no per-worktree install, no enter-to-arm, no repo-root pollution. The hook no-ops fast (and never spawns the daemon) when the cwd isn't a kobe task.
