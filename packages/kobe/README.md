<p align="center">
  <img src="docs/assets/brand/bracket-chip.gif" alt="kobe" width="720" />
</p>

<p align="center">
  <strong>One terminal, many Claude Code sessions.</strong><br/>
  kobe is a TUI that runs N Claude Code agents in parallel — each in its own git worktree — so you can drive a small team of tasks from one screen.
</p>

<p align="center">
  <em>Codename — will be renamed before any non-beta release.</em>
</p>

---

## What kobe is

A terminal UI on top of the `claude` CLI. It gives you a Conductor-shaped layout
(sidebar of tasks, workspace pane with chat + file tabs, file tree, embedded
terminal, status bar) and runs each task in its own isolated git worktree, so
multiple Claude Code sessions can edit the same repo at the same time without
stepping on each other.

If you've used a single `claude` session and wished you could fan out to five,
that's the gap kobe fills.

## Install

[![npm](https://img.shields.io/npm/v/%40sma1lboy%2Fkobe.svg)](https://www.npmjs.com/package/@sma1lboy/kobe)

You need three things on `PATH`:

- [**Bun**](https://bun.sh) ≥ 1.0 — kobe's renderer is opentui, which uses Bun-FFI.
- [**`claude`** CLI](https://docs.anthropic.com/en/docs/claude-code) — the engine kobe drives. Run `claude --version` to confirm it's installed and signed in.
- **`tmux`** — the embedded terminal pane uses one tmux session per task. On macOS: `brew install tmux`.

Then:

```bash
bun install -g @sma1lboy/kobe
kobe
```

Or run without installing:

```bash
bunx @sma1lboy/kobe
```

The first launch drops you into an empty sidebar — press `ctrl+n` to create
your first task. kobe will ask for a repo path and a base branch, then spin
up a worktree at `<repo>/.claude/worktrees/<task-id>/` and a chat pane
talking to a fresh `claude` session inside it.

## A glimpse

<p align="center">
  <img src="docs/assets/brand/pane-grid.gif" alt="kobe pane layout" width="720" />
</p>

## What you can do

Once you're in, the keys you'll use most:

| Key                | What it does                                                   |
| ------------------ | -------------------------------------------------------------- |
| `ctrl+n`           | New task (any pane, any time)                                  |
| `ctrl+1` / `2` / `3` / `4` | Jump straight to a pane (sidebar, workspace, files, terminal) |
| `tab`              | Cycle focus to the next pane                                   |
| `ctrl+q`           | Detach back to the sidebar (your task keeps streaming)         |
| `?`                | Show the full keybinding help dialog                           |
| `,` or `ctrl+,`    | Open Settings (theme, transparent background, dev reset)       |
| `q`                | Quit (with confirm)                                            |

Inside the sidebar, with a task highlighted: `j/k` to move, `enter` to open,
`r` to rename, `a` to archive, `d` to delete, `[` / `]` to switch between the
working session and the archives view.

Inside the chat composer:

- `enter` to send, `shift+enter` for a newline.
- `shift+tab` cycles the per-task tool-permission mode (`default → acceptEdits → plan`), forwarded to `claude` as `--permission-mode`.
- Click the model label in the footer to pick the model for this task (opus / sonnet / haiku).
- Type `/` to open the slash-command dropdown. Bundled `claude-code` commands and your own `.claude/{commands,skills}/*.md` are merged in.
- A `Create PR` chip on the chat header injects a PR-instructions prompt into the active task and routes the resulting PR through the orchestrator.

A given task can host **multiple chat tabs** on the same worktree — useful when
you want a parallel sub-conversation without losing the main thread.

For the full feature manifest, see [`CHANGELOG.md`](./CHANGELOG.md).

## Where things live

- Tasks: `~/.kobe/tasks.json`
- Per-task worktrees: `<repo>/.claude/worktrees/<task-id>/`
- UI state (theme, sidebar widths, last-active task): kobe's KV store, also under `~/.kobe/`

## Troubleshooting

**`command not found: claude`** — kobe shells out to the `claude` CLI; install
it from [the Claude Code docs](https://docs.anthropic.com/en/docs/claude-code)
and confirm `claude --version` works in the same shell you launched kobe from.

**`bun: command not found`** — install [Bun](https://bun.sh) (`curl -fsSL https://bun.sh/install | bash`).
kobe's renderer requires Bun ≥ 1.0; it does not run under Node.

**The terminal pane is blank / errors about tmux** — install `tmux` (`brew install tmux` on macOS).
The embedded terminal is one tmux session per task; without `tmux` on `PATH`,
the pane stays empty but the rest of kobe still works.

**`posix_spawnp failed` when running `bun run test:behavior`** — on macOS arm64,
Bun's installer occasionally ships `node-pty`'s prebuilt `spawn-helper` without
an exec bit. The behavior-test driver fixes it lazily on first spawn (see
`test/behavior/driver.ts`), so a re-run usually clears it. If not, run
`chmod +x node_modules/node-pty/build/Release/spawn-helper`.

**Worktree won't create** — kobe wants a clean git repo. The new-task dialog
validates the repo path before creating; if it's complaining, check that
`git status` runs cleanly inside the path you typed.

## Coming later

- Homebrew tap (mirroring [`sma1lboy/homebrew-codefox`](https://github.com/sma1lboy/homebrew-codefox)) so you can `brew install kobe` without touching Bun directly.
- Conductor-as-backend mode (Phase 2 in [`docs/PLAN.md`](./docs/PLAN.md)).

---

## For contributors

If you want to hack on kobe itself rather than just use it:

```bash
bun install
bun run dev          # boots the 5-pane TUI under KOBE_DEV=1 (no update chip, etc.)
bun run test         # unit + type tests
bun run test:behavior  # PTY-driven; spawns kobe as a real binary
bun run typecheck    # strict tsc
bun run build        # produces ./dist/index.js for `npm publish`
```

Architecture, design philosophy, and the team-of-agents operating model live in:

- [`docs/DESIGN.md`](./docs/DESIGN.md) — design philosophy, tech stack lock-in.
- [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md) — module map and current state.
- [`docs/HARNESS.md`](./docs/HARNESS.md) — the agent self-test contract.
- [`docs/PLAN.md`](./docs/PLAN.md) — phase / wave plan.
- [`HANDOFF.md`](./HANDOFF.md) — current direction + what just shipped.

### Releasing

Bump `package.json`, move `## [Unreleased]` in `CHANGELOG.md` to the new
version section, commit, then push the matching `vX.Y.Z` tag. The release
workflow ([`.github/workflows/release.yml`](./.github/workflows/release.yml))
runs typecheck + unit tests + build, asserts the tag matches `package.json`,
then `npm publish --provenance` and creates a GitHub release with the
changelog section as the body.
