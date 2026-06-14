---
"@sma1lboy/kobe": patch
---

Fixes from a sweep of the TUI panes, web UI, and remote-exec code:

- **Task titles no longer mojibake on emoji.** Deriving a title from a long prompt truncated on UTF-16 code units, which could split an emoji/astral character in half and leave an orphaned surrogate (a replacement glyph). Truncation now happens on whole code points.
- **Remote (SSH) launch handles spaces/metachars.** The ssh connection arguments woven into a remote task's tmux launch line are now quoted, so a key path or control path containing a space no longer breaks the launch.
- **Theme picker reflects a re-fetched theme set** even when the number of themes is unchanged (the snapshot compared only the count before).
- **Web terminal** no longer writes to a disposed xterm when a PTY frame arrives mid-unmount (a harmless-but-noisy throw on fast tab switches).
- **Tasks rail** re-highlights correctly when the selected task is deleted from another surface (the cursor could be left pointing past the shortened list).
- **Board settings** surface a clear error if the quick-action templates fail to load instead of leaving the form silently disabled.
