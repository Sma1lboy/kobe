---
"@sma1lboy/kobe": patch
---

Navigation and cycler chords are now rebindable in `~/.kobe/settings/keybindings.yaml`: `sidebar.nav` / `files.nav` (alternating `[down, up]` pairs — e.g. `sidebar.nav: [w, s]`), `files.hierarchy` (`[collapse, expand]` pairs), and `sidebar.view` / `files.tab` (`[prev, next]` pairs), with exact-count validation so a bad override keeps the default instead of scrambling directions. Shift-discriminated chords (gg/G, Shift+P, Shift+M) and the tmux-mirroring pane-focus set remain fixed, with accurate reasons shown in Settings.
