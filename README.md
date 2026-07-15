<p align="center">
  <img src="docs/assets/brand/bracket-chip.gif" alt="kobe" width="720" />
</p>

<p align="center">
  <strong>Run parallel coding agents from any terminal.</strong><br/>
  kobe is an SSH-friendly TUI for turning AI coding work into isolated git worktrees and persistent hosted engine sessions.
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@sma1lboy/kobe"><img src="https://img.shields.io/npm/v/%40sma1lboy%2Fkobe.svg" alt="npm version" /></a>
  <a href="https://github.com/Sma1lboy/kobe/actions/workflows/ci.yml"><img src="https://github.com/Sma1lboy/kobe/actions/workflows/ci.yml/badge.svg?branch=main" alt="CI" /></a>
  <a href="https://app.codecov.io/gh/Sma1lboy/kobe"><img src="https://codecov.io/gh/Sma1lboy/kobe/branch/main/graph/badge.svg" alt="coverage" /></a>
  <a href="./packages/kobe/CHANGELOG.md"><img src="https://img.shields.io/badge/changelog-latest-blue" alt="changelog" /></a>
</p>
<img width="2559" height="1510" alt="image" src="https://github.com/user-attachments/assets/f8dab7ca-43a1-4f76-adad-f19239f5f503" />

## A quick look

https://github.com/user-attachments/assets/17947cf2-bd90-41d8-9e56-2b30050f6d08

kobe opens into a PureTUI workspace with:

- **Sidebar** - create, switch, archive, rename, and organize tasks.
- **Workspace** - live engine or shell tabs, with persistent sessions and splits.
- **Files** - changed files, previews, diffs, and PR actions.

---

## Choose your AI engine

Use **Settings → Engine** to pick which AI CLI kobe should run for a task: `claude`, `codex`, `copilot`, or your own command.

https://github.com/user-attachments/assets/11fcc3e5-7d20-403d-82df-3e5d156d1dba

---

AI agents are useful one at a time. kobe is for when you want five attempts running at once.

```text
Task = git worktree + hosted engine sessions + branch
```

Create a task, send it to `claude`, `codex`, or `copilot`, close and reopen the TUI, compare the worktree, keep the good branch, archive the rest. It runs where your code already lives: your laptop, a devbox, a VPS, or any machine you can SSH into.

```bash
ssh devbox
cd repo
kobe
```

## Why try it

- **Made for SSH/devboxes** - no browser, VNC, or desktop app; the terminal is the product.
- **Persistent by default** - a standalone PTY Host owns engine sessions, so disconnects and daemon restarts do not kill the work.
- **Safe parallelism** - every attempt gets its own branch and worktree.
- **Real environment** - agents run next to your dependencies, services, credentials, and build cache.
- **Scriptable fan-out** - `kobe api` lets another agent or shell script spawn more tasks.

## Install

Requirements: [Bun](https://bun.sh) `>= 1.3.11`, git, and at least one engine CLI on `PATH` (`claude`, `codex`, or `copilot`).

```bash
bun install -g @sma1lboy/kobe
kobe
```

Or:

```bash
bunx @sma1lboy/kobe
```

First task: press `n`, choose a repo/base branch/engine, then prompt the workspace terminal. By default, kobe creates the worktree under:

```text
~/.kobe/worktrees/<repo-key>/<task-slug>/
```

## Useful keys

| Key | Action |
|---|---|
| `F1` | Show the full live keybinding reference. |
| `ctrl+q` | Focus the Sidebar; from the Sidebar, quit. |
| `F2` | Rename the active tab or split. |
| `F3` | Focus the next split. |
| `F4` | Cycle pane focus forward. |
| `F5` | Confirm and reset the active terminal. |
| `F6` | Toggle zen mode. |
| `F7` | Jump to the next task or tab waiting for attention. |
| `ctrl+t` / `ctrl+e` | Open an engine tab / choose an engine or shell. |
| `ctrl+w` | Close the active split, otherwise close the tab. |
| `ctrl+[` / `ctrl+]` | Switch to the previous / next tab. |
| `ctrl+a`, then `j` / `k` | Cycle pane focus backward / forward. |
| `ctrl+a`, then `f` | Quick-fork a child task. |
| `ctrl+a`, then `\\` / `=` | Split right / down. |

`F1` is authoritative and reflects the active scope and user overrides. More:
[`docs/KEYBINDINGS.md`](./docs/KEYBINDINGS.md).

## Browser dashboard

Prefer a browser? The same tasks, sessions, and terminals are available in a local web UI:

```bash
kobe web                 # http://localhost:5174
kobe web --port 5180
```

It talks to the same daemon as the TUI, so tasks created in either surface show up in both. Architecture lives in [`docs/design/web-dashboard.md`](./docs/design/web-dashboard.md).

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
kobe reset    # reset daemon + Hosted PTY runtime; does not delete worktrees
```

## Develop

```bash
bun install
bun run dev:sandbox
bun run typecheck
bun run lint
bun run test
```

Start with [`AGENTS.md`](./AGENTS.md), [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md), and [`packages/kobe/CHANGELOG.md`](./packages/kobe/CHANGELOG.md).

### Testing & coverage

Verification layers (contract: [`docs/HARNESS.md`](./docs/HARNESS.md)):

```bash
bun run test                                   # unit + socket suites (fast, CI-gated)
bun run build && bun run test:behavior         # black-box: the BUILT CLI in a temp home
                                               # + isolated daemon and Hosted PTY runtime
                                               # (CI-gated, `behavior` job)
bun run visual                                 # real OpenTUI through /harness + PTY (Linux CI gate)
cd packages/kobe && bun run coverage           # v8 coverage report (text + json-summary)
```

Two hard rules keep regressions from coming back:

- **Every bug fix ships a regression test** that fails before the fix and passes after, commented with the issue it pins. Environment-shaped bugs (terminal bytes, PATH state, packaged-vs-dev) get pinned in `test/behavior/`, not in a mocked unit test.
- **Per-touched-file coverage floor on PRs** — touched source must meet the current floor or carry a documented `coverage-exemption`. OpenTUI render paths are also covered by the native render and browser visual gates; there is deliberately no repo-wide percentage target. See [`docs/HARNESS.md`](./docs/HARNESS.md) for the current CI matrix.
