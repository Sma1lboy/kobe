---
"@sma1lboy/kobe": patch
---

Bound a repo's `.kobe/init.sh` with a watchdog so a hanging init can't wedge task entry. The init snippet woven before the engine now runs in a backgrounded subshell with stdin from `/dev/null` (an interactive `read`/password prompt gets EOF instead of blocking forever) under a POSIX `sleep N && kill` watchdog — no GNU `timeout(1)`, which macOS lacks. On timeout (default 120s, overridable via `KOBE_REPO_INIT_TIMEOUT_SECONDS`) the init subtree is TERM-then-KILLed and the launch continues to the engine with a legible banner; a failed or timed-out init never blocks the task and isn't marked done, so it retries next launch. The "same shell so `export`s reach the engine" contract is preserved across the subshell via an `export -p` env round-trip.
