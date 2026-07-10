---
"@sma1lboy/kobe": patch
---

Switching back to a background chattab no longer comes up with claude's UI missing. Two changes: hidden tabs' local terminal screens are no longer auto-parked (the reattach replay can't reconstruct a long session's full screen from the byte-capped ring buffer, so revived tabs could lose the input box — screens now stay resident, owner-accepted memory cost); and the TUI-restart reattach repaint wiggle no longer fires its two resizes back-to-back, where the child's SIGWINCHes coalesce into one same-size signal that apps like claude ignore — the restore now waits for the child's shrink repaint (200ms timeout fallback).
