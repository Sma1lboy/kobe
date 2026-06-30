---
"@sma1lboy/kobe": patch
---

fix: a fast Ctrl+C right after a task's engine pane appears no longer closes the pane mid-init. The engine ran inside a `sh -c` wrapper, so a SIGINT during the per-repo init script or the engine's startup window hit the whole process group and killed the wrapper before it reached the keep-alive fallback shell — tmux then closed the pane (the center pane "vanished"). The engine wrapper now traps SIGINT (`trap ':' INT`) so only the engine child receives Ctrl+C (it resets to the default handler and stays interruptible) while the wrapper survives and always lands on the fallback terminal. A pane now closes only on a deliberate `exit`.
