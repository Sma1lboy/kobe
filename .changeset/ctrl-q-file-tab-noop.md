---
"@sma1lboy/kobe": patch
---

Ctrl+Q is now a no-op in full-window file preview / editor tabs. It used to run tasks-restore against the preview window and graft a Tasks rail into the full-width view; the restore now only fires in real workspace windows (engine pane present, rail missing).
