---
"@sma1lboy/kobe": patch
---

Stop the sidebar spinner from running forever after a turn ends

The activity watchdog decided "is this turn still running?" from the engine
transcript's mtime. But an engine parked at its prompt keeps touching its
transcript, so whenever a Stop hook went missing the watchdog re-armed itself
on every window and the task spun indefinitely. It now reads the transcript's
newest turn-COMPLETION marker alongside the mtime: a completion at or after the
turn's start ends it regardless of how recent the writes are, while a long
single turn with no completion yet keeps its badge on the same heartbeat as
before. Engines without completion markers are unchanged.

Hook failures are also no longer completely silent — `KOBE_HOOK_DEBUG=1` logs
the reason to stderr, without ever failing the engine.
