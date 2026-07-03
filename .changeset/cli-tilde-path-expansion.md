---
"@sma1lboy/kobe": patch
---

Fix: CLI path arguments now expand a leading `~` to your home directory. A quoted or tool-forwarded `~` reaches kobe verbatim (the shell only expands unquoted words), and it was being treated as an ordinary path segment — so `kobe add "~/repo"`, `kobe remove ~/repo`, `kobe adopt ~/repo`, `kobe repo set --init-script-file ~/s.sh ~/repo`, `kobe theme import ~/theme.json`, and `kobe api --repo ~/repo` all resolved to a bogus `<cwd>/~/repo` path that failed the downstream git/file checks with a confusing "not a git repository / file not found" error. These entry points now expand `~` / `~/…` (honouring `KOBE_HOME_DIR`) before resolving relative paths against the current directory, so `~`-relative paths work the same as absolute ones.
