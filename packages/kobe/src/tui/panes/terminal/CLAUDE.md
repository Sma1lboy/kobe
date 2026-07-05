# `panes/terminal/` — mixed: live tmux stack + DORMANT embedded-terminal pane

This directory holds two unrelated things. Read this before assuming anything
here ships (or doesn't).

## Two stacks, one folder

**LIVE — the tmux session machinery (ships in v1, do NOT treat as dormant):**
`tmux.ts`, `tmux-session.ts`, `tmux-session-create.ts`, `tmux-session-bindings.ts`,
`layout-actions.ts`, `layout-coord.ts`, `pane-heal.ts`, `launch.ts`, `chattab.ts`.
These are imported all over the codebase (`cli/commands-tui.ts`, `tui/lib/task-enter.ts`,
`tmux/*`, `settings/host.tsx`, …) and drive the default product path — the tmux
handover. Nothing below applies to them.

**DORMANT — the embedded-terminal pane (this doc's subject):**
`Terminal.tsx`, `pty.ts`, `pty-pipe.ts`, `pty-types.ts`, `pty-mock.ts`, `registry.ts`,
`keys.ts`, `keys-pure.ts`, `xterm-chunks.ts`, `sgr.ts`, `sgr-to-text-chunk.ts`,
`terminal-render.ts` (~1820 lines).

## Status of the dormant cluster

**Dormant. Not wired into v1. Zero importers outside this directory — intentional.**
It was revived from git history as an in-process embedded shell pane (Conductor's
bottom-right terminal). It is kept in-tree on purpose but nothing renders it: the
native workspace host (`tui/workspace/host.tsx`) deliberately omits it and says so
in its header comment.

## Why it was parked

The `@xterm/headless`-backed pane's rendering bled outside its box — the snapshot
`<text>` painted past the pane's bounds instead of clipping to it. `Terminal.tsx`'s
own comments record how brittle the geometry is: cursor position is computed from
`body.screenY + cursor.y` and depends on a single flat multi-line `<text>` (one
`<text>` per row shifted `screenY` and parked the cursor a row off). That coupling
is what needs to be made robust before it can ship.

## What it is (by responsibility cluster)

- **Pane component** (`Terminal.tsx`): the Solid pane. Owns PTY acquire/subscribe
  lifecycle, scrollback/viewport slicing, geometry measurement + resize push, and
  the inline-cursor render path. Acquires a `TaskPty` from the registry keyed on
  `(taskId, cwd)`; never kills PTYs (the orchestrator owns release).
- **PTY backend** (`pty.ts`, `pty-pipe.ts`, `pty-types.ts`, `pty-mock.ts`,
  `registry.ts`): spawns a shell in the worktree behind `@xterm/headless`, exposes
  structured per-row snapshots + cursor, and refcounts live PTYs per task. `pty-pipe`
  is the non-headless fallback; `pty-mock` backs tests.
- **Input** (`keys.ts`, `keys-pure.ts`): key-event → byte-sequence translation for
  the focused pane (the pure half is side-effect-free and unit-testable).
- **Render** (`sgr.ts`, `sgr-to-text-chunk.ts`, `xterm-chunks.ts`,
  `terminal-render.ts`): turn xterm cells / SGR runs into opentui `StyledText`
  chunks, overlay the cursor cell, and detect the "shell missing" error state.

## Revival checklist

1. **Fix the rendering bleed** — clip the body `<text>` to the pane box; re-verify
   the `screenY + cursor.y` math survives resize and the single-`<text>` constraint.
2. **Wire it into the workspace host** — add the pane to `tui/workspace/host.tsx`
   (remove the "no embedded Terminal pane in v1" caveat there) and give it a focus
   slot.
3. **Route every user-visible string through i18n `t()`** — this cluster hardcodes
   English today: `Terminal.tsx` has `"Reset terminal?"` + its body, the
   `"terminal unavailable — …"` states, and `"(no task — press n to create)"`, which
   duplicates the `chat.composer.noTask` idea. Add a `terminal.*` namespace
   (`i18n/messages/terminal.ts`) in all locales; do not leave literals in the JSX.
4. **Add tests** — the cluster currently has none. `keys-pure.ts`, `sgr.ts`, and the
   viewport-slicing math are the natural pure-unit targets; `pty-mock.ts` already
   exists to back a component test.

## Dependency note

`@xterm/headless` in `packages/kobe/package.json` exists **solely** for this dormant
cluster (`pty.ts` imports it; `sgr.ts` falls back to it). If this cluster is ever
deleted rather than revived, that dependency goes with it.
