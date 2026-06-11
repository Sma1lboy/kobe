---
"@sma1lboy/kobe": patch
---

The web dashboard follows the TUI's theme, live: the bridge serves the TUI's 7 bundled theme JSONs resolved into the web's CSS token vocabulary (`GET /api/themes`, def-ref resolution mirroring the TUI's theme loader), and the SPA now consumes the daemon's `ui-prefs` channel — switching themes in any kobe session's Settings restyles every open dashboard immediately (new terminals pick up the matching xterm palette; the static claude palette stays as first-paint fallback). The Tasks rail also follows the TUI's sort-mode preference from the same channel.
