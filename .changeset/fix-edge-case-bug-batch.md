---
"@sma1lboy/kobe": patch
---

Fix a batch of edge-case bugs surfaced by an audit:

- **Daemon socket UTF-8 corruption.** A multibyte character (CJK, em-dash, emoji) in a task title, field note, or prompt could be split across two TCP chunks and decode to replacement characters (`�`). Both socket read paths now hold partial sequences across chunks with a `StringDecoder`.
- **Web tab migration crash.** A stored tab with an unrecognized `kind` (a forward-version or corrupted entry) passed straight through and later crashed the live SSE store update; it now degrades to a vendor tab, and a `file` tab that lost its path degrades to an empty chooser.
- **PTY sidecar.** Concurrent attaches to the same tab could orphan a PTY process (uncloseable, invisible); spawns are now single-flight. PTY writes/resizes on an exited handle no longer crash the sidecar, and `/pty/close` now enforces the same localhost-origin policy as the other PTY routes.
- **Workspace layout.** Switching away from a task while a pane was zoomed persisted a bogus right-column width into the shared layout; the capture now bails when the window is zoomed.
