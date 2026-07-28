# examples.worktree-include

A fresh git worktree has no gitignored files — no `.env`, no local config.
This plugin watches `worktree.created` and copies files matching the repo's
`.worktreeinclude` (one glob per line) from the main checkout into the new
worktree.

```bash
kobe plugin install Sma1lboy/kobe/plugins/worktree-include
echo '.env*' >> ~/your/repo/.worktreeinclude
```

For setup that must run *inside* the worktree (installs, `direnv allow`),
use kobe's built-in `.kobe/init.sh` instead; this plugin only copies files.
