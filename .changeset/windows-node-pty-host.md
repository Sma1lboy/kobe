---
"@sma1lboy/kobe": patch
---

Engine sessions and embedded terminals now actually run on Windows. kobe's only PTY path was `Bun.spawn(..., { terminal })`, which Bun rejects outright on Windows — every `pty.open` failed with "terminal option is not supported on this platform" and retried in a loop, so the TUI came up with panes that could never hold a session. The PTY host now spawns children through a small driver seam: Bun's terminal API everywhere it works, and `node-pty` (ConPTY) on Windows. node-pty cannot fill the gap from inside Bun either — Bun can read its output but writing to the ConPTY input pipe returns `ERR_SOCKET_CLOSED`, i.e. a terminal you cannot type into — so on Windows that one process runs under node instead, with the identical session, scrollback, replay, and wire-protocol code above the seam.

Its socket becomes a named pipe on Windows (`\\.\pipe\kobe-<home>-pty`), because node cannot bind a filesystem unix socket there. Clients are unchanged: they speak the same frame grammar, and only the pathname differs. Nothing changes on macOS or Linux — same process, same Bun spawn, same unix socket.
