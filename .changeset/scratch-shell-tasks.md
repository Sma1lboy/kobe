---
"@sma1lboy/rove": patch
---

Scratch temp shell tasks (issue #33 step 2): a PROPOSED `ctrl+a t` opens a bare shell as a scratch directory task, shown in a new Scratch section at the very top of the sidebar. Zero-ceremony lifecycle — the shell exiting removes the row. A scratch row earns a home by being renamed, or automatically: when a coding harness is confirmed live in the shell and its cwd settles inside a git repo, the row migrates into that repo's project group (selection follows, no dialogs, no focus steal). Unfamiliar repos get a non-modal save-as-project hint.
