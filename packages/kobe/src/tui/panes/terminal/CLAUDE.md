# `panes/terminal/` — mixed: live tmux stack + LIVE embedded-terminal pane

This directory holds two unrelated things. Read this before assuming anything
here ships. (Historical note: the embedded pane was dormant until the
terminal-in-the-middle pivot, issue #16, revived it — 2026-07-06.)

## Two stacks, one folder

**LIVE — the tmux session machinery (ships in v1, do NOT treat as dormant):**
`tmux.ts`, `tmux-session.ts`, `tmux-session-create.ts`, `tmux-session-bindings.ts`,
`layout-actions.ts` (dispatcher + workspace splits + tab lifecycle), `layout-plan.ts`
(pure split/parse policy), `layout-tmux.ts` (shared tmux plumbing + hidden helper
session), `layout-side-panes.ts` (ops/tasks/terminal hide-restore), `layout-zen.ts`
(zen mode), `layout-coord.ts`, `pane-heal.ts`, `launch.ts`, `chattab.ts`.
These are imported all over the codebase (`cli/commands-tui.ts`, `tui/lib/task-enter.ts`,
`tmux/*`, `settings/host.tsx`, …) and drive the default product path — the tmux
handover. Nothing below applies to them.

**LIVE — the embedded-terminal core (framework-free), since issue #16:**
`pty.ts`, `pty-pipe.ts`, `pty-hosted.ts`, `pty-xterm-base.ts`, `pty-types.ts`,
`pty-mock.ts`, `pty-scripted.ts`, `registry.ts`, `keys-pure.ts`, `xterm-chunks.ts`,
`sgr.ts`, `sgr-to-text-chunk.ts`, `terminal-render.ts`, `terminal-selection.ts`,
`viewport.ts`. The React pane that consumes this core lives in
`src/tui-react/panes/terminal/` (`Terminal.tsx`, `keys.ts`, the
`use-terminal-*` hooks) — the Solid pane was retired with the React
migration (2026-07-07).

## Status

**Live — the terminal-in-the-middle center column (issue #16).** The KOBE_TUI
workspace host mounts the React pane through
`tui-react/workspace/TerminalTabs.tsx` (the PTY-world chattab:
ctrl+t/ctrl+w/F2/ctrl+]/[ on registry keys `${taskId}::${tabId}`), running
the task's real interactive engine CLI via `interactiveEngineCommand`. Bleed
is contained by opentui `overflow="hidden"` + viewport slicing
(`viewport.ts`); the snapshot StyledText is assigned through the
renderable's `content` setter; a dead shell surfaces via the backends'
`onExit` + the pane's exit banner. User-visible strings route through the
`terminal.*` i18n namespace (`tui/i18n/messages/terminal.ts`).

## What it is (by responsibility cluster)

- **PTY backends** (`pty.ts` local Bun child, `pty-hosted.ts` daemon-hosted
  child over protocol v4, `pty-pipe.ts` non-headless fallback,
  `pty-xterm-base.ts` the shared xterm-headless emulation both real
  backends extend, `pty-mock.ts`/`pty-scripted.ts` test doubles,
  `registry.ts` per-task refcounting): spawn a shell/engine in the worktree
  behind `@xterm/headless` and expose structured per-row snapshots + cursor.
- **Input** (`keys-pure.ts`): key-event → byte-sequence translation, pure
  and unit-tested (`test/tui/terminal-keys-pure.test.ts`); the React event
  wiring is `tui-react/panes/terminal/keys.ts`.
- **Render** (`sgr.ts`, `sgr-to-text-chunk.ts`, `xterm-chunks.ts`,
  `terminal-render.ts`, `viewport.ts`, `terminal-selection.ts`): turn xterm
  cells / SGR runs into opentui `StyledText` chunks, slice the viewport,
  overlay cursor/selection, and detect the "shell missing" error state.

## Dependency note

`@xterm/headless` in `packages/kobe/package.json` exists for this cluster
(`pty-xterm-base.ts` builds on it; `sgr.ts` falls back to it). If this
cluster is ever deleted, that dependency goes with it.
