---
"@sma1lboy/kobe": patch
---

Event-driven task state from engine hooks (Claude Code) — replacing the polling guesswork with real signals.

kobe now installs Claude Code hooks into each task's worktree so the engine reports what it's actually doing — turn started/finished, rate-limited, or waiting on a permission prompt — straight to the daemon, which folds it into a per-task activity state and pushes it to the sidebar. Task rows show a live `working` spinner while a turn runs, and a `done` / `limited` / `approve?` / `error` chip otherwise, instead of inferring state by polling the tmux pane. The whole mechanism sits behind a neutral `EngineHookAdapter` seam (Claude is the first implementation; the daemon, CLI, and TUI never name a vendor), so Codex/Copilot can plug into the same contract later. The hooks are written to the worktree's `.claude/settings.local.json` and hidden from git via `.git/info/exclude` so they never pollute a task's diff, and they only own the events kobe drives — a user's own hooks are preserved. The polling turn-detector stays as a fallback. Internal `kobe hook <verb>` command (fired by the hooks) never spawns the daemon and always exits 0, so it can't keep an idle daemon alive or fail an engine turn.
