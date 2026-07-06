# `panes/terminal/` — mixed: live tmux stack + LIVE embedded-terminal pane

This directory holds two unrelated things. Read this before assuming anything
here ships. (Historical note: the embedded pane was dormant until the
terminal-in-the-middle pivot, issue #16, revived it — 2026-07-06.)

## Two stacks, one folder

**LIVE — the tmux session machinery (ships in v1, do NOT treat as dormant):**
`tmux.ts`, `tmux-session.ts`, `tmux-session-create.ts`, `tmux-session-bindings.ts`,
`layout-actions.ts`, `layout-coord.ts`, `pane-heal.ts`, `launch.ts`, `chattab.ts`.
These are imported all over the codebase (`cli/commands-tui.ts`, `tui/lib/task-enter.ts`,
`tmux/*`, `settings/host.tsx`, …) and drive the default product path — the tmux
handover. Nothing below applies to them.

**LIVE — the embedded-terminal pane (this doc's subject), since issue #16:**
`Terminal.tsx`, `pty.ts`, `pty-pipe.ts`, `pty-types.ts`, `pty-mock.ts`, `registry.ts`,
`keys.ts`, `keys-pure.ts`, `xterm-chunks.ts`, `sgr.ts`, `sgr-to-text-chunk.ts`,
`terminal-render.ts` (~1820 lines).

## Status

**Live — the terminal-in-the-middle center column (issue #16).** The KOBE_TUI
workspace host mounts it through `tui/workspace/TerminalTabs.tsx` (the PTY-world
chattab: ctrl+t/ctrl+w/F2/ctrl+]/[ on registry keys `${taskId}::${tabId}`),
running the task's real interactive engine CLI via `interactiveEngineCommand`.
Bleed is contained by opentui 0.4 `overflow="hidden"` + viewport slicing
(`viewport.ts`); the snapshot StyledText is assigned through the renderable's
`content` setter (the solid binding's content prop stringifies at runtime);
a dead shell surfaces via the backends' `onExit` + the pane's exit banner.

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

## Revival checklist (ALL DONE — issue #16, PRs #249/#250 + terminal tabs)

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
4. **Add tests for the untested half** — `sgr.ts` is already covered
   (`test/tui/terminal-sgr.test.ts` + `terminal-sgr-attrs.test.ts`); the gaps are
   `keys-pure.ts` and the viewport-slicing math. `pty-mock.ts` already exists to
   back a component test.
5. **Surface a dead-shell state on the Bun PTY** — `BunTerminalTaskPty` (`pty.ts`)
   has no error-surfacing path. Unlike `PipeTaskPty` (`pty-pipe.ts` appends spawn
   errors to the buffer), a post-spawn shell crash just `markDead`s and freezes the
   last snapshot — the pane shows stale output with no signal. Wire an exit/error
   indicator into the pane on revival.

## Dependency note

`@xterm/headless` in `packages/kobe/package.json` exists **solely** for this dormant
cluster (`pty.ts` imports it; `sgr.ts` falls back to it). If this cluster is ever
deleted rather than revived, that dependency goes with it.
