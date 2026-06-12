---
"@sma1lboy/kobe": patch
---

**Drag board cards between status columns** — on `kobe web`'s `/board`, drag a card (anywhere with the pointer, or its grip handle with the keyboard: Enter to lift, arrows to jump columns, Enter to drop) onto another column to move the task's lifecycle status. The drop paints instantly and the daemon round-trip confirms; a refused move (e.g. the `done` ↔ `error` guard) rolls the card back with a toast naming the blocked transition. Dragging disables with a `read-only (offline)` chip while the daemon or stream is down, so a drop can never silently vanish. Daemon RPC errors now carry their error name end-to-end (daemon → bridge → browser), so the web UI can branch on typed failures instead of string-matching messages.
