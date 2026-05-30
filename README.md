<p align="center">
  <img src="docs/assets/brand/bracket-chip.gif" alt="kobe" width="720" />
</p>

<p align="center">
  <strong>Run parallel coding agents from any terminal.</strong><br/>
  kobe is an SSH-friendly TUI for turning AI coding work into isolated git worktrees and persistent tmux sessions.
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@sma1lboy/kobe"><img src="https://img.shields.io/npm/v/%40sma1lboy%2Fkobe.svg" alt="npm version" /></a>
  <a href="./packages/kobe/CHANGELOG.md"><img src="https://img.shields.io/badge/changelog-latest-blue" alt="changelog" /></a>
</p>

---

AI agents are useful one at a time. kobe is for when you want five attempts running at once.

```text
Task = git worktree + tmux session + branch
```

Create a task, send it to `claude`, `codex`, or `copilot`, detach, reattach, compare the worktree, keep the good branch, archive the rest. It runs where your code already lives: your laptop, a devbox, a VPS, or any machine you can SSH into.

```bash
ssh devbox
cd repo
kobe
```

## Why try it

- **Made for SSH/devboxes** - no browser, VNC, or desktop app; the terminal is the product.
- **Persistent by default** - agents live in tmux, so disconnects do not kill the work.
- **Safe parallelism** - every attempt gets its own branch and worktree.
- **Real environment** - agents run next to your dependencies, services, credentials, and build cache.
- **Scriptable fan-out** - `kobe api` lets another agent or shell script spawn more tasks.

## A quick look

<p align="center">
  <img src="docs/assets/brand/pane-grid.gif" alt="kobe pane layout" width="720" />
</p>

kobe opens into a tmux workspace with:

- **Tasks** - create, switch, archive, rename, retarget.
- **Engine** - the live AI CLI session.
- **Ops** - changed files, previews, `@file` mentions, PR prompts.
- **Shell** - a normal shell inside the task worktree.

## Install

Requirements: [Bun](https://bun.sh) `>= 1.3.11`, `tmux`, and at least one engine CLI on `PATH` (`claude`, `codex`, or `copilot`).

```bash
bun install -g @sma1lboy/kobe
kobe
```

Or:

```bash
bunx @sma1lboy/kobe
```

First task: press `n`, choose a repo/base branch/engine, then prompt the engine pane. kobe creates the worktree under:

```text
<repo>/.claude/worktrees/<task-slug>/
```

## Useful keys

| Key | Action |
|---|---|
| `ctrl+h/j/k/l` | Move between Tasks, engine, Ops, and shell panes. |
| `ctrl+q` | Detach; tasks keep running in tmux. |
| `ctrl+t` | New ChatTab on the same task/worktree. |
| `ctrl+[` / `ctrl+]` | Previous / next ChatTab. |
| `F2` | Rename the current ChatTab. |
| tmux `prefix f` | Open the new-task dialog. |

More: [`docs/KEYBINDINGS.md`](./docs/KEYBINDINGS.md).

## Fan out

```bash
kobe api fan-out \
  --repo "$PWD" \
  --agents claude:2,codex:1 \
  --prompt "Try three approaches to simplify the auth flow."
```

Install the companion skill so Claude Code knows when to use `kobe api`:

```bash
npx skills add Sma1lboy/kobe --skill kobe --agent claude-code
```

## If it gets stuck

```bash
kobe doctor   # read-only diagnosis
kobe reset    # reset daemon + kobe tmux sessions; does not delete worktrees
```

## Develop

```bash
bun install
bun run dev:sandbox
bun run typecheck
bun run lint
bun run test
```

Start with [`HANDOFF.md`](./HANDOFF.md), [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md), and [`packages/kobe/CHANGELOG.md`](./packages/kobe/CHANGELOG.md).
