---
"@sma1lboy/kobe": patch
---

Stop a dev-sandbox daemon from blanking the task sidebar of a real session.

An explicit socket-path override outranks the sandbox home, and the TUI stamps the production socket onto every task terminal it spawns — so a `dev:sandbox` started from inside one bound the real socket and served its own empty task index. Attached sessions reconnected onto it and showed "No active tasks" while every task sat intact on disk.

The sandbox now drops inherited socket/pid paths and uses its own web port, and `hello` reports the daemon's home so a client refuses one that belongs somewhere else instead of adopting its task list. Recovery needs no restart: the reconnect loop re-syncs as soon as the right daemon holds the socket.
