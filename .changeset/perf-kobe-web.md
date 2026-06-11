---
"@sma1lboy/kobe": patch
---

Web dashboard efficiency: the embedded terminal's scrollback no longer reflattens a 256KB string on every PTY output chunk (bounded chunk ring; the browser reuses one TextDecoder), and the daemon→browser SSE bridge only forwards the channels the SPA actually consumes instead of every daemon channel.
