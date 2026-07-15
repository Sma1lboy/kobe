# Contributing to kobe

Thanks for your interest in contributing! kobe is a local-first terminal UI for running many AI coding sessions at once — each task is a git worktree + hosted engine session + branch.

This guide covers the mechanics of contributing. The design rationale lives in `docs/` — when this file and those docs disagree, the docs win.

## Before you start

Read these, in order:

1. [`docs/DESIGN.md`](./docs/DESIGN.md) — design philosophy, architecture decisions, tech stack.
2. [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md) — source-tree map and ownership boundaries.
3. [`docs/KEYBINDINGS.md`](./docs/KEYBINDINGS.md) — required reading before adding or moving any keyboard chord.
4. [`packages/kobe/CHANGELOG.md`](./packages/kobe/CHANGELOG.md) — current shipped behavior and release-note style.

The tech stack is locked: **TypeScript + `@opentui/core` + `@opentui/react` + React 19 + Bun**. Proposals to swap any of these will not be accepted — see `docs/DESIGN.md` for why.

## Prerequisites

- [Bun](https://bun.sh) `>= 1.3.11`
- At least one engine CLI on `PATH`: `claude`, `codex`, or `copilot`
- git

## Setup

```bash
git clone https://github.com/Sma1lboy/kobe.git
cd kobe
bun install
```

This is a Bun-workspaces monorepo:

- [`packages/kobe/`](./packages/kobe) — the published CLI and PureTUI.
- [`packages/kobe-daemon/`](./packages/kobe-daemon) — daemon protocol/server and Hosted PTY runtime.
- [`packages/kobe-web/`](./packages/kobe-web) — browser dashboard and PTY sidecar.
- [`packages/branding/`](./packages/branding) — Remotion render pipeline for brand assets.

The current ownership map is in [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md).

Run package scripts from the root via `bun --filter @sma1lboy/kobe <script>`, or `cd packages/kobe` first. Most common scripts are also aliased at the root (`bun run dev`, `bun run test`, etc.).

### Reference repos (optional but recommended)

kobe deliberately borrows ideas from a set of reference projects cloned into `refs/` (gitignored). If you're touching engine adapters, stream rendering, or status/usage derivation, clone the relevant refs first — see the "Reference repos" section in [`AGENTS.md`](./AGENTS.md) for the list and what each one is for. **Never edit anything inside `refs/`** — it's read-only study material.

## Development

Two dev flavours:

| Script | Engine | State directory | Use when |
|---|---|---|---|
| `bun run dev` | Real `claude` / `codex` | `~/.kobe` (production) | Touching production-style state. |
| `bun run dev:sandbox` | Real `claude` / `codex` | `packages/kobe/.dev-sandbox/home` (throwaway) | Day-to-day development. Won't touch your real `~/.kobe/tasks.json`. |

The sandbox gets its own home, daemon, and PTY host, so it can coexist with a production kobe. After changing daemon, orchestrator, or engine code, run `bun run dev:sandbox:reset` so a long-lived sandbox process isn't still running old code.

Debugging the daemon? Read `<KOBE_HOME>/.kobe/daemon.log` first — the daemon's stdout/stderr are redirected there, and errors are tagged by `[subsystem]`. Use `kobe daemon restart` to replace a stale daemon process.

## Checks — run before every PR

```bash
bun run lint          # formatting and static checks
bun run typecheck     # tsc --noEmit
bun run test          # fast Vitest suite + Unix-socket daemon suite
bun run build
bun run test:behavior # built CLI against an isolated daemon and Hosted PTY
```

For a native OpenTUI visual change, also run `bun run visual`; it is the only
visual acceptance path and drives `/harness → xterm.js → PTY → real OpenTUI`.
CI runs the full required matrix. The exact track selection and current gates
live in [`docs/HARNESS.md`](./docs/HARNESS.md).

## Making changes

### Scope and style

- Keep PRs focused. Cross-cutting changes should be surfaced and discussed first, not bundled in.
- **Layout is flex-first.** opentui boxes follow Yoga flexbox semantics — use `flexGrow`/`flexShrink`/`flexBasis` for sizing, not hardcoded `width={N}`/`height={N}`. Hardcoded dimensions are acceptable only for documented conventions, fixed terminal glyphs, or modal overlays. See "Layout: flex-first, hardcode last" in [`CLAUDE.md`](./CLAUDE.md).
- **Engine adapters own UI data.** Neutral layers (TUI, orchestrator) must not hard-code Claude/Codex-specific strings, parse vendor transcript files, or derive vendor-specific metrics. Product names, model catalogs, history, and usage metrics all come from the engine contract (`AIEngine.identity`, `EngineCapabilities`, `EngineHistory`). If a pane needs engine-specific data, extend the engine contract first.
- Background consumers subscribe as `role: "pane"` (the default). `role: "gui"` is reserved for an attached TUI or browser whose lifetime represents a human client — getting this wrong breaks daemon shutdown. See "Daemon lifecycle" in [`AGENTS.md`](./AGENTS.md).
- Diagrams in `docs/` use Mermaid fences, not ASCII art (tiny ≤3-node relationships excepted).

### Commits

- Conventional-style messages: `<type>: <one-line summary>` (`feat:`, `fix:`, `chore:`, `docs:`, …), with a short body explaining the why.
- No AI/tool attribution footers (no `Co-Authored-By: Claude`, no "Generated with …" lines).
- Never use `--no-verify` or skip hooks. If a hook fails, fix the underlying issue.

### Changesets

Every change that affects what the published package *does* (feature, fix, behavior change) needs a changeset:

```bash
bun run changeset
```

Commit the generated `.changeset/<name>.md` with your change. The summary is the user-facing changelog line — write it in product voice, present tense, as **one long line** (no soft wraps; GitHub renders single newlines as `<br>` in release bodies). Pure tooling/docs/CI changes need no changeset.

Default the bump to `patch` — kobe is pre-1.0 and ships features as patches; a `minor` happens only when a maintainer explicitly calls for it. Full release mechanics are in [`docs/RELEASING.md`](./docs/RELEASING.md) (cutting releases is maintainer-only).

## Work tracking

The product backlog is local. Everything used for normal development is
repo-local:

- **Backlog**: the daemon-owned issue store — see [`docs/WORK-TRACKING.md`](./docs/WORK-TRACKING.md).
- **Shipped behavior**: [`packages/kobe/CHANGELOG.md`](./packages/kobe/CHANGELOG.md), via changesets.
- **Durable design decisions**: Markdown in `docs/`.

GitHub Issues are reserved for inbound user reports; do not create them for
normal project planning.

## Pull request checklist

- [ ] `bun run typecheck`, `bun run lint`, `bun run test`, and `bun run build` all pass.
- [ ] User-visible change → changeset added; behavioral test run or considered.
- [ ] Keybinding added/moved → consistent with [`docs/KEYBINDINGS.md`](./docs/KEYBINDINGS.md).
- [ ] Layout change → flex props, not magic constants.
- [ ] New engine-facing behavior → goes through the engine contract, no vendor strings in neutral layers.
- [ ] Docs updated if the change contradicts anything in `docs/`.

## Questions

Open a [GitHub issue](https://github.com/Sma1lboy/kobe/issues) or start a discussion on your PR. If a doc and the implementation disagree, surface the mismatch — don't silently pick one.
