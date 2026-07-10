---
"@sma1lboy/kobe": patch
---

Behavior tests now scrub inherited kobe controls and isolate HOME/XDG state so their teardown cannot reset live daemon, PTY, or tmux sessions.
