---
"@sma1lboy/kobe": patch
---

fix: reattached terminal sessions repaint, dead engine tabs resume

A same-size reattach (TUI restart, park-sweep wake) raised no SIGWINCH, so nothing repainted the ring-buffer replay and the engine's UI came back as a garbled/stale screen until a manual window resize — the hosted backend now wiggles one row and back after a live reattach, tmux's attach behavior. An engine tab whose child died while the TUI was away now resumes its conversation (`--resume <sessionId>`, one attempt) instead of silently degrading to an empty shell.
