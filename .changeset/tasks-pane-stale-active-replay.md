---
"@sma1lboy/kobe": patch
---

Opening a task no longer snaps the spawned session's Tasks pane highlight to the first row. Before, every freshly built task session showed its sidebar cursor on the top task instead of the one you opened.

Root cause was two effects fighting at mount: the sidebar's "reset cursor to 0 on view switch" effect ran once at mount (it wasn't deferred), clobbering the cursor that the select-from-`selectedId` effect had just positioned on the opened task. A fresh pane mounts on every new task session, so the reset always won. Deferring the view-switch reset so it only fires on an actual later view change fixes it; the initial cursor is owned by the selectedId-sync effect.

Also hardened the related path: a spawned Tasks pane now ignores the daemon's replayed `active-task` value (which, on subscribe, is still the pre-switch task because `setActiveTask` is published after `switch-client`) until the channel confirms its own task — so the highlight no longer flashes the previously-entered task before settling.
