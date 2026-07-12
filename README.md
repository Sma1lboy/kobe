# kobe

kobe is a local-first terminal workspace for running many AI coding sessions
in parallel. Each task gets an isolated git worktree and persistent engine
sessions, while one PureTUI keeps tasks, terminals, files, diffs, and status in
view.

```text
Task = git worktree + hosted engine sessions + branch
```

## What it gives you

- Persistent engine sessions owned by a standalone PTY Host. Closing the TUI
  or restarting the daemon does not end them.
- One workspace for Claude Code, Codex, Copilot CLI, and user-defined engines.
- Per-task git worktrees, task lifecycle, file tree, changes, diffs, terminal
  tabs, splits, and session history.
- A scriptable `kobe api` control plane for agents and automation. Prompted
  `send`, `add`, and `fan-out` auto-start the canonical hosted engine session
  even when no TUI is open.
- Local-first state: engine authentication, repositories, sessions, and task
  data stay on your machine.

## Requirements

- [Bun](https://bun.sh) 1.3.11 or newer
- git
- at least one engine CLI on `PATH`: `claude`, `codex`, or `copilot`

## Install and launch

```bash
bun install -g @sma1lboy/kobe
kobe add .
kobe
```

Plain `kobe` always launches the PureTUI Workspace Host. There is no alternate
UI mode flag or environment switch.

## Essential keys

| Key | Action |
|---|---|
| `F1` | Full live keybinding help |
| `ctrl+q` | Return focus to the Sidebar; press again to quit |
| `ctrl+h/j/k/l` | Focus Sidebar / Workspace / Files / Terminal |
| `ctrl+t` / `ctrl+w` | Open / close a Terminal Tab |
| `ctrl+[` / `ctrl+]` | Previous / next Terminal Tab |
| `F2` | Rename active tab or split |
| `F3` | Focus next split |
| `F4` | Cycle pane focus |
| `F5` | Reset the active terminal |
| `F6` | Toggle zen mode |
| `ctrl+a`, then `e` | New tab with an engine or shell picker |
| `ctrl+a`, then `f` | Quick-fork a new task |
| `ctrl+a`, then `\\` / `=` | Split right / down |

Press `F1` for the authoritative, scope-aware list. Customize direct and
prefix chords in `~/.kobe/settings/keybindings.yaml`; changes reload live.

## CLI

```bash
kobe --help
kobe api --help
kobe daemon status
kobe daemon restart
kobe web
```

Examples for automation:

```bash
kobe api add --repo . --prompt "implement the parser" --pretty
kobe api fan-out --repo . --agents claude:2,codex:1 --prompt "try three approaches"
kobe api send --task-id <id> --prompt "run the focused tests"
kobe api pty-list --pretty
```

## Development

```bash
bun install
bun run dev:sandbox
bun run lint
bun run typecheck
bun run test
bun run build
bun run test:behavior
```

`dev:sandbox` uses `packages/kobe/.dev-sandbox/home`, including isolated
daemon and PTY-host state. After daemon/orchestrator/engine edits, use
`bun run dev:sandbox:reset`.

Architecture and contribution rules live in [AGENTS.md](./AGENTS.md),
[docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md), and
[docs/HARNESS.md](./docs/HARNESS.md).

## License

MIT
