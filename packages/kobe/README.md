# @sma1lboy/kobe

The published kobe CLI and PureTUI package.

```bash
bun install -g @sma1lboy/kobe
kobe add /path/to/repo
kobe
```

Plain `kobe` launches one React/opentui Workspace Host. Interactive engine and
shell processes are owned by the standalone PTY Host, so they survive TUI exits
and daemon restarts.

```text
Task = git worktree + hosted engine sessions + branch
```

## Main commands

```bash
kobe --help
kobe web
kobe daemon status
kobe daemon restart
kobe api --help
```

Prompted API calls can run headlessly. `send`, prompted `add`, and `fan-out`
ensure the task Worktree and canonical `<taskId>::tab-1` hosted engine session
without requiring an open TUI.

```bash
kobe api add --repo . --prompt "implement the feature" --pretty
kobe api send --task-id <id> --prompt "run tests"
kobe api pty-list --pretty
```

Press `F1` in the TUI for live help. Direct and prefix bindings are configured
in `~/.kobe/settings/keybindings.yaml`.

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
