---
"@sma1lboy/kobe": patch
---

`kobe update --list` (or `kobe update list`) now opens a TUI versions browser in interactive terminals — j/k through recent releases with current/latest/breaking tags, the selected release's notes alongside (fetched lazily, cached), Enter installs that exact version via the shell updater, and a `kobe reset` warning shows before installing across a breaking version. Piped/scripted invocations keep the plain text list.
