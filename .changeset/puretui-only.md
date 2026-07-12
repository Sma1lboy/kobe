---
"@sma1lboy/kobe": patch
---

Make PureTUI the only kobe interface, move all interactive task sessions to the standalone Hosted PTY backend, and keep headless `kobe api send`, prompted `add`, and `fan-out` automation able to start and reuse engine sessions without an open TUI.
