---
"@sma1lboy/kobe": patch
---

Trim the bundled themes to three — `claude`, `conductor`, `tokyonight`. The other ten (`catppuccin`, `dracula`, `everforest`, `gruvbox`, `kanagawa`, `nord`, `opencode`, `osaka-jade`, `rose-pine`, `solarized`) now install on demand: `kobe theme add https://kobe.sma1lboy.me/themes/<name>.json`. Nothing about them changed except where they're stored, and the gallery at https://kobe.sma1lboy.me/themes previews all thirteen.

If you were using one of the moved themes, kobe falls back to `claude` until you install it again with the command above.

Also fixes a related bug that would have made this much worse: a theme installed with `kobe theme add` was validated against the bundled set on the next boot, so it silently reverted to the fallback. Hosts that load `~/.kobe/themes` now validate against the registry they just populated, so a user-installed theme survives a restart.
