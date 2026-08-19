# @sma1lboy/rove

The published Rove CLI and PureTUI package.

Install it any of these ways:

```bash
curl -fsSL https://rove.sma1lboy.me/install.sh | sh   # installs Bun if needed, then Rove
npm install -g @sma1lboy/rove                         # npm
bun install -g @sma1lboy/rove                         # bun
npx @sma1lboy/rove                                    # no install
```

Then:

```bash
rove add /path/to/repo
rove
```

The CLI runs on the Bun runtime. The published `rove` / `kobe` bins are node
launchers that re-exec through Bun, so an `npm install -g` or `npx` on a
machine without Bun still ends up with a working Rove.

The package also keeps `kobe` as a compatibility alias. Both executable names
copy supported legacy state into `~/.rove` and `~/.config/rove` without deleting
or overwriting the old files; daemon-owned stores wait until the legacy writer
has stopped.

Plain `rove` launches one React/opentui Workspace Host. Interactive engine and
shell processes are owned by the standalone PTY Host, so they survive TUI exits
and daemon restarts.

```text
Task = git worktree + hosted engine sessions + branch
```

## Main commands

```bash
rove --help
rove web
rove daemon status
rove daemon restart
rove api --help
```

Prompted API calls can run headlessly. `send`, prompted `add`, and `fan-out`
ensure the task Worktree and canonical `<taskId>::tab-1` hosted engine session
without requiring an open TUI.

```bash
rove api add --repo . --prompt "implement the feature" --pretty
rove api send --task-id <id> --prompt "run tests"
rove api pty-list --pretty
```

Press `F1` in the TUI for live help. Direct and prefix bindings are configured
in `~/.rove/settings/keybindings.yaml`.

## Development

From the monorepo root:

```bash
bun install
bun run dev:sandbox
bun run lint
bun run typecheck
bun run test
bun run build
bun run test:behavior
```

See the root [README](../../README.md), [architecture](../../docs/ARCHITECTURE.md),
and [harness contract](../../docs/HARNESS.md).
