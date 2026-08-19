---
"@sma1lboy/rove": patch
---

**Install Rove with npm, npx, or one curl line — Bun no longer has to be there first.** The published `rove` and `kobe` bins are now small node launchers: started by Bun they run the CLI in-process as before, started by node (which is what `npm install -g` and `npx` do) they find a Bun runtime and re-exec through it. When there is no Bun at all, the first launch offers to install it instead of dying with `env: bun: No such file or directory`. Bun is discovered on `PATH`, in `$BUN_INSTALL/bin`, in `~/.bun/bin`, and in a `bun` package installed beside Rove; `ROVE_BUN=/path/to/bun` points at one anywhere else, and `ROVE_NO_BUN_BOOTSTRAP=1` turns the offer back into a plain error for CI and images.

New one-step installer for a machine with nothing on it: `curl -fsSL https://rove.sma1lboy.me/install.sh | sh` installs Bun when it is missing, then Rove, and tells you exactly what to add to `PATH` if the bin directory is not there yet.
