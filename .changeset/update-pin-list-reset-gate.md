---
"@sma1lboy/kobe": patch
---

Version-pinned updates + the breaking-version reset gate. `kobe update <version>` installs an exact release (the install script accepts `sh -s -- <version>`), `kobe update --list` prints recent releases with the current and breaking ones marked, and the script itself answers `--list` too. A new `BREAKING_VERSIONS` registry drives two guards: `kobe update` warns before installing across a breaking release, and the TUI/web entrances refuse to start after crossing one (either direction) until `kobe reset` runs — soft reset re-stamps the gate, `--hard`'s wipe counts as fresh. Worktrees stay untouched, as always.
