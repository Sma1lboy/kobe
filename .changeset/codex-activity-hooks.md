---
"@sma1lboy/kobe": patch
---

Wire Codex's hook mechanism for engine activity, mirroring Claude. Codex sessions now report `session-start` / `turn-start` / `turn-complete` and auto-adopt freshly-created worktrees via `~/.codex/hooks.json` (same settings-file shape as Claude). The read/merge/write I/O and install/remove methods are consolidated into a shared `JsonHookAdapter` base class, so each engine adapter is just its event→verb table plus settings path. `turn-failed` / `session-end` / `awaiting-input` stay on the polling fallback (Codex has no matching observer events); Codex's per-engine hook trust prompt still applies.
