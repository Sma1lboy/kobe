---
"@sma1lboy/kobe": patch
---

Fix a multi-process lost-update on `~/.config/kobe/state.json`: the TUI's settings store used to flush its whole in-memory snapshot back to disk, silently clobbering keys another kobe process (Tasks pane, CLI, settings window) wrote during the debounce window — e.g. an engine switched with `v` could revert after touching a setting elsewhere. All writers now go through a single state-store module that merges only their changed keys onto a fresh read, atomically.
