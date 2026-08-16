---
"@sma1lboy/rove": patch
---

Fix shell env inconsistency (#26): `pane-open --command`, plugin panes, and the automation precheck now spawn through the same `resolveLoginShell()` + `-ilc` integration path engine tabs already use, instead of a bare `sh -lc` / non-interactive `-lc` that skips `.zshrc`/`.bashrc`. Panes and prechecks see the same PATH/exports as the engine they accompany.
