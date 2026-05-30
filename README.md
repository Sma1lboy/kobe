<p align="center">
  <img src="docs/assets/brand/bracket-chip.gif" alt="kobe" width="720" />
</p>

<p align="center">
  <strong>Run a small team of coding agents from one terminal.</strong><br/>
  kobe is a local-first TUI that turns each task into a git worktree, a tmux session, and a live engine pane.
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@sma1lboy/kobe"><img src="https://img.shields.io/npm/v/%40sma1lboy%2Fkobe.svg" alt="npm version" /></a>
  <a href="./packages/kobe/CHANGELOG.md"><img src="https://img.shields.io/badge/changelog-latest-blue" alt="changelog" /></a>
</p>

---

## Why kobe exists

AI coding tools are great at one thread. Real work is rarely one thread.

kobe gives you a terminal-native cockpit for running parallel coding attempts without leaving your shell. Create a task, let it work in its own git worktree, switch to another task, compare changes in the Ops pane, and keep every engine conversation alive in tmux.

The product unit is simple:

```text
Task = git worktree + tmux session + branch
```

That means experiments do not trample your main checkout, long-running agents keep working after you detach, and every attempt has a branch you can inspect, merge, archive, or delete.

## What it feels like

<p align="center">
  <img src="docs/assets/brand/pane-grid.gif" alt="kobe pane layout" width="720" />
</p>

kobe opens directly into a tmux workspace:

| Pane | Purpose |
|---|---|
| Tasks | Switch, create, archive, rename, retarget, and open task worktrees. |
| Engine | Your live `claude`, `codex`, or `copilot` CLI session. |
| Ops | Browse files, changes, previews, `@file` mentions, and PR prompts. |
| Shell | A normal shell already inside the task worktree. |

Each task can have multiple ChatTab tmux windows on the same worktree, so you can keep a main thread and branch off side conversations without losing context.

<p align="center">
  <img src="docs/assets/brand/task-streams.gif" alt="kobe task streams" width="720" />
</p>

## Highlights

- **Local-first orchestration** - state lives on disk under `~/.kobe`, engine transcripts stay where each CLI already stores them, and work happens in normal git worktrees.
- **Tmux-native runtime** - detach with `ctrl+q`, reattach later, and keep engine panes alive without a cloud service.
- **Multi-engine by CLI** - works with local Claude Code, Codex, and GitHub Copilot CLI sessions through engine-owned contracts.
- **Worktree isolation** - every task gets a branch and checkout, so parallel attempts can edit the same repo safely.
- **Ops pane for review** - browse changed files, inject `@file` mentions, open previews, and ask an agent to prepare a PR.
- **Agent-to-agent fan-out** - `kobe api` lets any shell-capable agent spawn and drive more kobe tasks.
- **Packaged recovery tools** - `kobe doctor` diagnoses daemon/tmux state; `kobe reset` fixes wedged runtime state without touching worktrees.

## Install

Requirements:

- [Bun](https://bun.sh) `>= 1.3.11`
- [tmux](https://github.com/tmux/tmux)
- At least one supported engine CLI on `PATH`: `claude`, `codex`, or `copilot`

Install from npm:

```bash
bun install -g @sma1lboy/kobe
kobe
```

Or run without installing:

```bash
bunx @sma1lboy/kobe
```

Optional preview dependencies improve image and SVG rendering in the Ops pane:

| Platform | Preview dependencies |
|---|---|
| macOS | `brew install chafa ffmpeg librsvg` |
| Debian / Ubuntu | `sudo apt install chafa ffmpeg librsvg2-bin` |
| Fedora | `sudo dnf install chafa ffmpeg librsvg2-tools` |
| Arch | `sudo pacman -S chafa ffmpeg librsvg` |
| Windows | `winget install hpjansson.chafa Gyan.FFmpeg` |

## First run

From a git repo:

```bash
kobe
```

Then:

1. Press `n` in the Tasks pane.
2. Pick or enter the repo path and base branch.
3. Choose an engine.
4. Send the first prompt in the engine pane.

kobe creates a worktree under:

```text
<repo>/.claude/worktrees/<task-id>/
```

The task appears in the Tasks pane and the engine runs inside that worktree. Detach with `ctrl+q`; relaunch `kobe` to re-enter the workspace.

## Daily workflow

```text
1. Create a task for an idea, bug, or refactor.
2. Let the engine work in its isolated branch.
3. Spawn another task for a competing approach.
4. Use Ops to inspect changed files and inject follow-up context.
5. Open the worktree in your editor or ask the agent to prepare a PR.
6. Archive finished tasks; keep the branch/worktree history available.
```

Core shortcuts:

| Key | Action |
|---|---|
| `ctrl+h/j/k/l` | Move between Tasks, engine, Ops, and shell panes. |
| `ctrl+q` | Detach from the tmux workspace. |
| `ctrl+t` | Create another ChatTab window on the same task. |
| `ctrl+shift+t` or tmux `prefix T` | Pick an engine, then create a ChatTab. |
| `ctrl+[` / `ctrl+]` | Switch ChatTab windows. |
| `ctrl+w` | Close the current ChatTab window when another one exists. |
| `F2` | Rename the current ChatTab. |
| tmux `prefix f` | Focus Tasks and open the new-task dialog. |

More keybinding detail lives in [`docs/KEYBINDINGS.md`](./docs/KEYBINDINGS.md).

## Fan out from the shell

kobe exposes a JSON CLI for agents and scripts:

```bash
kobe api fan-out \
  --repo "$PWD" \
  --agents claude:2,codex:1 \
  --prompt "Find three different ways to simplify the auth flow."
```

Useful verbs:

| Verb | Use |
|---|---|
| `spawn-task` | Create one task, optionally start it with a prompt. |
| `fan-out` | Spawn many tasks from one prompt. |
| `send` | Paste a follow-up into a task's engine pane. |
| `get-task` | Read one task's metadata. |
| `collect` | Compare branches, running state, and uncommitted change counts. |
| `list` | List tasks. |

Install the companion agent skill so an AI assistant knows when to use this surface:

```bash
npx skills add Sma1lboy/kobe --skill kobe --agent claude-code
```

## Recovery

When something feels stuck, diagnose first:

```bash
kobe doctor
```

`kobe doctor` is read-only. It reports daemon health, tmux sessions, runtime files, and recent daemon logs.

If the runtime is wedged:

```bash
kobe reset
```

`kobe reset` stops the daemon, removes its socket and pidfile, and kills kobe-owned tmux sessions. It does not delete git worktrees. `kobe reset --hard` additionally wipes the task index and UI state, but still does not touch worktrees.

## Architecture

This repo is a Bun workspace:

| Package | What it owns |
|---|---|
| [`packages/kobe`](./packages/kobe) | The published TUI, daemon, tmux session layout, engine adapters, and CLI. |
| [`packages/branding`](./packages/branding) | Remotion pipeline for the brand assets in [`docs/assets/brand`](./docs/assets/brand). |

The main package has four layers:

```text
TUI / tmux panes
  -> orchestrator
    -> engine contract
      -> local engine CLIs
```

Important boundaries:

- Panes ask the orchestrator for task state; they do not parse engine transcripts directly.
- The orchestrator owns task/worktree/index lifecycle.
- Engine adapters own product identity, history, telemetry, and vendor-specific transcript formats.
- tmux is the live runtime surface; the legacy outer opentui monitor is deprecated and only available behind `KOBE_OUTER_MONITOR=1`.

Read more:

- [`docs/DESIGN.md`](./docs/DESIGN.md) - product philosophy and design decisions
- [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md) - source tree and ownership map
- [`docs/HARNESS.md`](./docs/HARNESS.md) - self-test contract for contributors
- [`packages/kobe/CHANGELOG.md`](./packages/kobe/CHANGELOG.md) - shipped behavior by release

## Develop locally

```bash
bun install
bun run dev:sandbox
```

`dev:sandbox` uses an isolated home directory and tmux socket:

```text
packages/kobe/.dev-sandbox/home
KOBE_TMUX_SOCKET=kobe-sandbox
```

Reset only the sandbox runtime:

```bash
bun run dev:sandbox:reset
```

Before sending a change, run:

```bash
bun run typecheck
bun run lint
bun run test
```

For user-visible TUI work, also run:

```bash
bun run test:behavior
```

## Contributing

kobe is young and moving fast. The best contributions are concrete, user-visible improvements to the terminal workflow:

- Better Ops previews and diff review.
- More reliable engine lifecycle handling.
- Sharper tmux pane ergonomics.
- Documentation that helps real users recover from stuck sessions.
- Focused bug reports with `kobe doctor` output and reproduction steps.

Start with [`HANDOFF.md`](./HANDOFF.md) for the current project state, then read [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md) before changing code. The latest shipped behavior is always in [`packages/kobe/CHANGELOG.md`](./packages/kobe/CHANGELOG.md).

## Status

kobe is open source and usable, but still a codename-stage project. The CLI surface and tmux-native workflow are active, the package is published as [`@sma1lboy/kobe`](https://www.npmjs.com/package/@sma1lboy/kobe), and releases are tracked in the changelog.
