---
"@sma1lboy/kobe": patch
---

Opening a different file from the file tree while the editor tab is already showing one no longer makes the tab twitch, close itself, and need a second click. The pty host now tags `pty.exit` frames (and the `pty.open` response) with the child's pid, so a kill→reopen under the same session key — the editor-tab file swap, F5 reset, engine degrade-to-shell — can no longer have the OLD child's exit frame race in and kill the freshly-opened session's handle.
