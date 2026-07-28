# examples.github-start

Turn a GitHub issue or PR into a running kobe task in one command: fetches the
title/body with `gh`, then `kobe api add` creates the task, worktree, and
engine session with the issue as the first prompt.

```bash
kobe plugin install Sma1lboy/kobe/plugins/github-start
cd ~/your/repo
kobe plugin action invoke examples.github-start.start https://github.com/owner/repo/issues/123
```

Requires `node` and an authenticated `gh` CLI.
