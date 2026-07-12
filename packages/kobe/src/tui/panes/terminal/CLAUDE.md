# `panes/terminal/` — Hosted PTY terminal core

This directory owns the framework-free embedded-terminal implementation used
by the React Workspace Host. The standalone PTY Host owns child processes;
the TUI attaches, renders snapshots, sends input, and detaches without ending
the session.

## Responsibility clusters

- `pty-hosted.ts`, `pty.ts`, `pty-pipe.ts`, and `registry.ts`: acquire and
  release hosted sessions keyed as `${taskId}::${tabId}`.
- `pty-xterm-base.ts`, `sgr.ts`, `sgr-to-text-chunk.ts`, `xterm-chunks.ts`,
  `terminal-render.ts`, `terminal-selection.ts`, and `viewport.ts`: terminal
  emulation, styled snapshots, cursor, selection, and viewport slicing.
- `keys-pure.ts`: key-event to terminal-byte translation.
- `pty-mock.ts` and `pty-scripted.ts`: test doubles.

The React pane lives under `src/tui-react/panes/terminal/`; workspace tab and
split ownership lives under `src/tui-react/workspace/` and
`src/tui/workspace/`.

`@xterm/headless` is load-bearing for `pty-xterm-base.ts` and must remain while
this terminal core exists.
