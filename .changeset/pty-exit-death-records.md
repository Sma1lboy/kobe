---
"@sma1lboy/kobe": patch
---

Engine sessions that die now leave a queryable cause of death (issue #9). The PTY host records exit code, signal, and exit time on every session end: the `pty.log` "session exited" line carries the cause (`(code 1)` / `(signal SIGKILL)`), `pty.exit` frames and `pty.list`/`pty.peek` expose it, and abnormal exits persist a durable record (code/signal/time + the last plain-text output lines) to `pty-exits.json`, surviving the host's idle-exit. `get-task` tab rows report `exit` for abnormally-dead tabs, `read-output` terminal pages include `terminal.exit`, and `kobe api inspect` gains a `sessionExits` section with the persisted records and output tails. Clean exits (code 0) stay quiet, and every new exit-path hook is fail-safe.
