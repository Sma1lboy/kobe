---
"@sma1lboy/rove": patch
---

Define PTY multi-client arbitration for sessions with more than one attached client (TUI pane, browser tab, api reader). Input follows tmux semantics — every attached client may type, and one `pty.write` payload always reaches the child as one contiguous chunk — while resize is last-writer-wins with the letterbox tradeoff taken deliberately rather than shrinking the session to its smallest viewer. A resize is now a no-op when the grid is unchanged (no spurious SIGWINCH from a client re-reporting its own size) and a real change is broadcast to the other attached clients as a `pty.resized` event, so their terminal emulator can follow the child's real dimensions instead of silently misrendering wrapped output.
