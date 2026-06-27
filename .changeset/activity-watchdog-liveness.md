---
"@sma1lboy/kobe": patch
---

fix: stop the activity watchdog from idling a still-running task mid-turn

The daemon's engine-activity badge armed a fixed ~10min lapse timer for any non-idle state and idled the task when it fired. But a long single agent turn emits only `turn-start` … `Stop` over many minutes with no hook events in between, so the timer fired mid-turn and wrongly dropped a working agent's badge to idle. The watchdog now probes the engine's transcript mtime before lapsing: a write within the trailing staleness window means the turn is alive (re-arm a heartbeat instead of idling), while a genuinely silent engine (missed Stop / hung process) still lapses. The probe is filesystem-only and best-effort — failure falls back to the old lapse behavior, never crashing the daemon.
