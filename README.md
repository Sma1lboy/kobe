# Rove — the agent multiplexer for your terminal

<p align="center">
  <img src="docs/assets/brand/bracket-chip.gif" alt="Rove — the agent multiplexer for your terminal" />
</p>

Rove is a terminal-native workspace for running multiple coding tasks in parallel with [Claude Code](https://claude.com/claude-code), [Codex](https://github.com/openai/codex), [Copilot](https://github.com/github/copilot-cli), Kimi, or any CLI you register. 

Rove isolates parallel work in git worktrees and branches, while agent and shell sessions keep running when you disconnect.

<p align="center">
  <a href="https://www.npmjs.com/package/@sma1lboy/rove"><img src="https://img.shields.io/npm/v/%40sma1lboy%2Frove?style=flat-square&label=npm&color=c96442" alt="npm version" /></a>
  <a href="https://github.com/Sma1lboy/rove/actions/workflows/ci.yml"><img src="https://img.shields.io/github/actions/workflow/status/Sma1lboy/rove/ci.yml?branch=main&style=flat-square" alt="build" /></a>
  <a href="./LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue?style=flat-square" alt="MIT license" /></a>
</p>

<p align="center">
  <a href="https://docs.rove.sma1lboy.me"><strong>Documentation</strong></a> ·
  <a href="https://docs.rove.sma1lboy.me/docs/quick-start">Quick start</a> ·
  <a href="https://docs.rove.sma1lboy.me/docs/concepts">Concepts</a> ·
  <a href="https://docs.rove.sma1lboy.me/docs/cli">CLI</a> ·
  <a href="https://docs.rove.sma1lboy.me/docs/api">Agent API</a> ·
  <a href="https://rove.sma1lboy.me">Website</a>
</p>

<p align="center">
  <img src="docs/assets/demo.gif" alt="Rove demo — two tasks running at once, each on its own worktree and branch" /><br />
  <a href="docs/assets/demo.mp4">Watch the full-quality MP4</a>
</p>

The sidebar tracks tasks and their sessions, the workspace embeds the active agent or shell, and the files pane shows the worktree's changes. Switch tasks to review output, inspect diffs, run tests, or send the next instruction.

## Quick start

Requires [Bun](https://bun.sh) ≥ 1.3.11, git, and at least one supported agent CLI on `PATH`. Rove runs on macOS, Linux, and Windows; Windows also requires Node.js and Git for Windows/Git Bash.

Try it without installing:

```bash
bunx @sma1lboy/rove
```

Or install it globally, then launch it in a repository:

```bash
bun install -g @sma1lboy/rove
cd your-repo
rove
```

Press `n`, choose a repository, base branch, and agent, then enter a prompt. Press `F1` for the live keybinding reference; `ctrl+q` returns to the sidebar and quits from there without stopping sessions.

The package also installs `kobe` as a compatibility alias; `rove` is the canonical command. On first launch, supported legacy state is copied additively into `~/.rove`; existing files and worktrees stay in place.

## Why Rove

- **Parallel tasks** — keep a refactor, bug fix, test investigation, and review moving at the same time.
- **Git isolation** — each managed task owns a worktree and branch, so agents working on different tasks do not overwrite each other's files.
- **Persistent sessions** — quit the TUI or drop SSH, then reattach without stopping the work.
- **Your existing agents** — use the real Claude Code, Codex, Copilot, Kimi, or custom CLI, with its own authentication, permissions, models, and access to the local environment.
- **Terminal-native** — run Rove where the code lives: laptop, devbox, VPS, or a narrow mobile SSH session.
- **Automation-ready** — scripts and coding agents can create, inspect, message, and land tasks through `rove api`.

## How it works

```text
Managed task
├── git worktree
├── git branch
└── terminal tabs
    ├── Claude Code
    ├── Codex
    └── shell
```

Tabs inside one task share its files; create separate managed tasks when work needs isolation. Project-main tasks and `rove .` directory tasks deliberately reuse an existing directory. Sessions continue in the background when the TUI detaches, and Rove restores them when you return.

The usual loop is simple: start several different tasks, switch between their live sessions, review each worktree's diff and checks, send follow-up instructions, then merge the completed branches. See [Concepts](./docs/CONCEPTS.md) and [Sessions](./docs/SESSIONS.md) for the full lifecycle.

## Scripting and Agent API

`rove api` exposes the same task model to shell scripts and coding agents. A typical workflow creates a task, checks its output, sends follow-up instructions, and lands the completed branch:

```bash
rove api add --repo "$PWD" --prompt "Fix the flaky auth test."
rove api list
rove api read-output --task-id <id>
rove api send --task-id <id> --prompt "Run the integration suite too."
rove api land --task-id <id>
```

Install the companion skill to let a coding agent orchestrate Rove directly:

```bash
rove skill install
```

Tasks created from inside another Rove session remember which task and tab dispatched them, so workers can report results back without an external coordinator. The API also covers task inspection, notifications, prompts, panes, issue tracking, routines, and worktree-safe lifecycle operations.

See the [Agent API reference](https://docs.rove.sma1lboy.me/docs/api) for every verb, flag, and exit code.

## Built for the terminal

Rove works with the tools you already use: your editor, terminal, git workflow, and coding agents.

It runs the interactive agent CLIs you already use, keeps their sessions alive on the host, and lets you manage parallel coding tasks directly from your terminal — including over SSH.

- **Terminal TUI** — no desktop app required
- **SSH-native** — the same workflow works on remote machines
- **Persistent sessions** — disconnect and come back without losing running agents
- **Existing agent CLIs** — Claude Code, Codex, Copilot, Kimi, or your own
- **Git-native isolation** — parallel tasks can live in separate worktrees and branches
- **Programmable** — orchestrate tasks through `rove api`

## More features

- **Review:** diff views and inline notes sent back as one agent prompt
- **Recovery:** rate-limit resume, cross-engine handoff, and multiple agents within one task
- **Remote ergonomics:** narrow/mobile layouts, a durable Inbox, notifications, and attachments
- **Unattended work:** scheduled routines with optional prechecks that skip idle runs
- **Planning context:** local Kanban, GitHub issue intake, and reusable repository field notes
- **Customization:** themes and plugins with custom panes, events, and commands

Explore the [TUI guide](./docs/TUI.md), [Routines](./docs/ROUTINES.md), [configuration](./docs/CONFIGURATION.md), and [plugin authoring](./docs/PLUGIN-AUTHORING.md) for details.

## Troubleshooting

```bash
rove doctor
```

See [Troubleshooting](./docs/TROUBLESHOOTING.md) for diagnostics and recovery steps.

## Development

```bash
bun install
bun run dev:sandbox
bun run test
```

Start with [CONTRIBUTING.md](./CONTRIBUTING.md) and [Architecture](./docs/ARCHITECTURE.md). Shipped behavior lives in the [changelog](./packages/kobe/CHANGELOG.md).

## License

[MIT](./LICENSE) © Jackson Chen
