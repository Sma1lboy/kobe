---
"@sma1lboy/kobe": patch
---

`kobe api send` / peer prompt delivery no longer garbles the attached TUI's pane (issue #18). The headless delivery client used to reattach via `pty.open` with a hardcoded 80×24, which the host's last-attach-wins rule turned into a real resize — the engine got SIGWINCH and repainted at 80 cols under a wider pane, wrapping content into the left half. Delivery now peeks + writes without ever attaching (indistinguishable from keyboard input), size-less `pty.open`s from other headless clients (ensure/spawn paths) no longer resize a live session, and delivery no longer clears a parked tab's exact-delta restore state. Sized reattaches (a real TUI) keep the tmux-style last-attach-wins behavior.
