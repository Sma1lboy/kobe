---
"@sma1lboy/kobe": patch
---

Hard-blocking CLI errors now point to the next step: a wedged/failed daemon start names the daemon log path and `kobe doctor`, missing tmux gets a platform install command instead of stale version wording, and the top-level CLI error is trimmed to a one-line message (set `KOBE_DEBUG=1` for the full stack). Running bare `kobe` outside a git repo no longer permanently saves the cwd as a project — it now lands on the empty kobe-home session with a pointer to `kobe add <path>`.
