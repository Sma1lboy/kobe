---
"@sma1lboy/rove": patch
---

`rove plugin install` no longer fails with EXDEV when /tmp is its own filesystem

The install cloned into the OS temp dir and finished by renaming that checkout
into `~/.kobe/plugins/<id>/checkout`. Wherever `/tmp` is a separate filesystem
— tmpfs on most Linux distros, and always so under WSL2 — `rename(2)` across
devices fails, so every install died with `EXDEV: cross-device link not
permitted` *after* cloning, confirming, and running the plugin's build.

The clone now stages in a `.staging-*` directory inside the plugins root
itself, which keeps the final move a same-device rename, and the move falls
back to copy-then-delete if the two paths still land on different devices.
