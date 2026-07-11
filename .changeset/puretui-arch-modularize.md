---
"@sma1lboy/kobe": patch
---

Internal: pure-TUI architecture sweep — split near-cap modules along real seams (keybindings chord table, keymap-overrides parse/apply, terminal-tabs split-tree policy), single-owner the bundled theme registry, and consolidate duplicated helpers (relative-age/clamp-cursor, path leaf, cell-width/truncation, chord-cap resolution, pane-orchestrator boot, page-close chords). No behavior change.
