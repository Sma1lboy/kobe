---
"@sma1lboy/kobe": patch
---

Web engine tabs gain a prompt composer under the terminal — type a prompt (Shift+Enter for multi-line) and Enter pastes it into the engine via bracketed paste + submit, the same delivery contract as kobe's tmux prompt paste, so driving a session no longer requires raw terminal typing. A dropped PTY WebSocket now shows a "detached — the session keeps running" bar with a one-click Reattach that reconnects to the same server-side PTY and replays its scrollback, replacing the old dead-end `[detached]` line.
