---
"@sma1lboy/kobe": patch
---

Snapshot the binding stack at keymap-dispatch entry so a handler that synchronously mounts/unmounts components (mutating the live stack via Solid mount/cleanup) can't skip or double-visit the in-flight scan. Precedence is unchanged — the same top-down LIFO order is searched and the same binding wins. Also adds a re-entrancy guard that drops a nested dispatch triggered from inside a handler, so a single keypress resolves to at most one binding (no behavior change for the normal, non-re-entrant case).
