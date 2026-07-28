# First-party example plugins

Working examples of the kobe plugin contract (`kobe-plugin.toml` + argv
commands — see [docs/design/plugins.md](../docs/design/plugins.md)). Install
any of them straight from this repo:

```bash
kobe plugin install Sma1lboy/kobe/plugins/notify            # desktop/ntfy notifications on agent events
kobe plugin install Sma1lboy/kobe/plugins/github-start      # start a task from a GitHub issue/PR
kobe plugin install Sma1lboy/kobe/plugins/worktree-include  # copy .env-style files into new worktrees
kobe plugin install Sma1lboy/kobe/plugins/linear-start      # start a task from a Linear issue (fzf picker)
kobe plugin install Sma1lboy/kobe/plugins/lazygit           # lazygit on the task worktree, as a pane tab
kobe plugin install Sma1lboy/kobe/plugins/browser           # Chromium in a pane tab (carbonyl)
```

These are examples to copy, not a standard library: fork one, change the id,
publish your own repo with the GitHub topic `kobe-plugin`, and it shows up in
the marketplace (https://kobe.sma1lboy.me/plugins.html) automatically.

Authoring loop:

```bash
kobe plugin link ./my-plugin        # register your working directory
kobe plugin action list             # see what registered
kobe plugin log <id>                # inspect hook runs
```
