---
"@sma1lboy/kobe": patch
---

fix: a superseded project switch no longer steals the active task

Hardening alongside the cursor-stranding fix: when several project switches
overlap, a slow `enterTask` (cold session create) used to call `setActiveTask`
only after its session was built, so an earlier, slower switch could finish last
and clobber the shared active task. `enterTask` now takes an `isCurrent` guard
and the Tasks pane stamps each switch with a monotonic token, so a superseded
switch skips the disruptive `setActiveTask` + `switch-client` — the last switch
wins.
