---
"@sma1lboy/kobe": patch
---

Tab titles follow the live process, and `kobe api pty-list` exposes it headlessly.

The tab strip's naming precedence is now manual rename > live OSC window title > first-prompt auto-title > vendor default — so a claude session's own dynamic title ("✳ …" conversation summary) names its tab while it runs, instead of only surfacing when no auto-title existed. The pty host now tracks each session's last OSC 0/2 title (plain string scan with a cross-chunk carry — still no VT emulation) plus pid and command, `pty.list` reports them, and a new read-group verb `kobe api pty-list` lists hosted sessions without a TUI attached; it never spawns a host (no host → empty `sessions`). Note: a pty host started before this release keeps serving the old `{ key, alive }` shape until it naturally turns over.
