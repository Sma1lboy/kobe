---
"@sma1lboy/kobe": patch
---

kobe now starts and holds a session on Windows. Every engine tab and embedded terminal is launched through a composed POSIX shell script (`trap`, `export -p`, `$$`, `kill -TERM`, `[ -f ]`), and the shell was hardcoded to `/bin/zsh` / `/bin/bash`, so on Windows the PTY spawn of a nonexistent argv0 took the whole process down with a native heap corruption (`0xC0000374`) about a minute after boot. The shell now resolves through one place, which picks Git for Windows' bash — already present on any machine that can run kobe, since kobe is git-worktree native — and paths interpolated into that script are converted to the form bash reads (`C:\a\b` → `/c/a/b`), which also fixes `.kobe/init.sh` being emitted as `.kobe\init.sh`. macOS and Linux are unchanged: each call site keeps the exact fallback it always had.

The daemon and PTY host also no longer open a stray terminal window on Windows. They are spawned with `detached: true`, which on Windows means `DETACHED_PROCESS` — the background service got its own console, which the OS drew as a second terminal window next to the TUI that retitled itself after whatever the hosted engine was running. POSIX still detaches exactly as before.

Repo checkouts are now pinned to LF via `.gitattributes`. Without it a Windows clone lands as CRLF and the first `bun run lint` reports every line of every file as changed.
