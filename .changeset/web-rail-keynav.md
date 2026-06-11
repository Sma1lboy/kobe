---
"@sma1lboy/kobe": patch
---

The task rail gets keyboard-first navigation: `j`/`k` (or `↑`/`↓`) move between the visible tasks and open them, matching the TUI's muscle memory — suppressed while typing in a field or while any dialog/palette is open. Also cleaned up the kobe-web lint state to fully pass `biome check` (the package's own lint wasn't exit-code-gated before, so a few latent unused-import / a11y / hook-dep items had accumulated).
