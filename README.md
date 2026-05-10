<p align="center">
  <img src="docs/assets/brand/bracket-chip.gif" alt="kobe" width="720" />
</p>

<p align="center">
  <strong>A TUI orchestrator for Claude Code.</strong><br/>
  Conductor-shaped 5-pane terminal app: many sessions in flight, one place to drive them.
</p>

<p align="center">
  <em>Codename — will be renamed before any public release.</em>
</p>

---

## What it is

kobe is a terminal UI that runs multiple Claude Code sessions in parallel, each in its own git
worktree. The layout copies Conductor's grammar (sidebar of tasks, workspace pane with a chat
tab and per-file tabs, files tree, terminal, status bar) but the engine and theming follow Claude
Code's own conventions so a kobe session feels like a Claude Code session — not a third-party
shell wrapping it.

## Stack

**TypeScript** + **[`@opentui/core`](https://github.com/sst/opentui) / `@opentui/solid`** + **Solid.js** + **Bun**.
Tests via vitest + PTY-driven behavior tests. Lint via biome. Engine spawns the `claude` CLI as a
subprocess and parses `--output-format stream-json`.

## Install (end users)

[![npm](https://img.shields.io/npm/v/%40sma1lboy%2Fkobe.svg)](https://www.npmjs.com/package/@sma1lboy/kobe)

Requires [Bun](https://bun.sh) ≥ 1.0 on the host (kobe's renderer is
opentui, which uses Bun-FFI). The `claude` CLI must also be on `PATH`.

```bash
bun install -g @sma1lboy/kobe
kobe                 # launches the TUI
```

Or run without installing:

```bash
bunx @sma1lboy/kobe
```

## Quick start (developing on kobe itself)

```bash
bun install
bun run dev          # boots the 5-pane TUI
bun run test         # unit + type tests
bun run test:behavior  # PTY-driven; spawns kobe as a real binary
bun run build        # produces ./dist/index.js for `npm publish`
```

Tasks live at `~/.kobe/tasks.json`; per-task git worktrees live at
`<repo>/.claude/worktrees/<task-id>/`.

## Releasing

Bump `package.json`, move `## [Unreleased]` in `CHANGELOG.md` to the
new version section, commit, then push the matching `vX.Y.Z` tag.
The release workflow ([`.github/workflows/release.yml`](./.github/workflows/release.yml))
runs typecheck + unit tests + build, asserts the tag matches
`package.json`, then `npm publish --provenance` and creates a GitHub
release with the changelog section as the body.

Current direction, what just shipped, and what's next live in [`HANDOFF.md`](./HANDOFF.md)
and [`CHANGELOG.md`](./CHANGELOG.md).
