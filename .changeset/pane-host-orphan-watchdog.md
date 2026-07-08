---
"@sma1lboy/kobe": patch
---

fix: every pane host now runs an orphan watchdog — if the process is reparented to init (its tmux pane / terminal is gone and no teardown signal ever arrived, e.g. the parent chain was SIGKILLed), it exits within seconds instead of living forever with a revoked tty. Complements the existing exit-signal backstop, which only fires when a signal is actually delivered.
